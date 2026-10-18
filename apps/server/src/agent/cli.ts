import { execFile, spawn } from 'node:child_process'
import { access, constants, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import type { AgentCli, AgentKind, LocalCliInfo, LocalCliUpdateResult } from '@plein/protocol'
import semver from 'semver'

const exec = promisify(execFile)

export type CliKind = Exclude<AgentKind, 'builtin'>

interface CliSpec {
  name: string
  /** npm 上的包：查最新版本、npm 全局安装时用来更新 */
  pkg: string
  install: string
  login: string
}

const SPECS: Record<CliKind, CliSpec> = {
  claude: {
    name: 'Claude Code',
    pkg: '@anthropic-ai/claude-code',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude auth login',
  },
  codex: {
    name: 'Codex',
    pkg: '@openai/codex',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
  },
}
const KINDS = Object.keys(SPECS) as CliKind[]

/** 终端 PATH 里找不到时再看的常见安装位置（从 Finder / Dock 打开的桌面端拿不到 shell 里的 PATH） */
function commonDirs(home = homedir()) {
  return [
    join(home, '.local/bin'),
    join(home, '.claude/local'),
    join(home, '.npm-global/bin'),
    join(home, '.bun/bin'),
    join(home, '.volta/bin'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}

/** nvm / fnm 装的各个 Node 版本的 bin，新版本在前 */
async function nodeVersionDirs(home = homedir()) {
  const out: string[] = []
  const scan = async (root: string, sub: string) => {
    const names = await readdir(root).catch(() => [] as string[])
    const sorted = names
      .filter((n) => semver.valid(semver.coerce(n)))
      .sort((a, b) => semver.rcompare(semver.coerce(a)!, semver.coerce(b)!))
    for (const n of sorted) out.push(join(root, n, sub))
  }
  await scan(join(home, '.nvm/versions/node'), 'bin')
  await scan(join(home, '.local/share/fnm/node-versions'), 'installation/bin')
  await scan(join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin')
  return out
}

export interface ResolvedCli extends AgentCli {
  path?: string
}

export interface CliEnvironment {
  /** 启动智能体时用的 PATH：终端 PATH 在前，常见目录补在后面 */
  path: string
  agents: ResolvedCli[]
}

let cached: Promise<CliEnvironment> | null = null

/** 找本机的 claude / codex；结果缓存，force 时重新检测（用户刚装好、刚更新） */
export function detectClis(force = false): Promise<CliEnvironment> {
  if (force || !cached) cached = detect()
  return cached
}

async function detect(): Promise<CliEnvironment> {
  const path = mergePath(
    await loginShellPath(),
    process.env.PATH ?? '',
    commonDirs().join(delimiter),
    (await nodeVersionDirs()).join(delimiter),
  )
  const agents = await Promise.all(
    KINDS.map(async (id): Promise<ResolvedCli> => {
      const name = SPECS[id].name
      const bin = await which(id, path)
      if (!bin) return { id, name, available: false }
      const version = await exec(bin, ['--version'], {
        timeout: 10_000,
        env: { ...process.env, PATH: path },
      })
        .then((r) => r.stdout.trim().split('\n')[0])
        .catch(() => undefined)
      return { id, name, available: true, version, path: bin }
    }),
  )
  return { path, agents }
}

/** 登录 shell 的 PATH（nvm、Homebrew 等在 shell 配置里加的目录）；Windows 直接用当前 PATH */
async function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return ''
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const { stdout } = await exec(shell, ['-ilc', 'printf "__PLEIN_PATH__%s" "$PATH"'], {
      timeout: 5_000,
    })
    return stdout.split('__PLEIN_PATH__')[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

function mergePath(...lists: string[]) {
  const seen = new Set<string>()
  for (const list of lists) for (const d of list.split(delimiter)) if (d) seen.add(d)
  return [...seen].join(delimiter)
}

async function which(name: string, path: string): Promise<string | undefined> {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const dir of path.split(delimiter)) {
    for (const ext of exts) {
      const file = join(dir, name + ext)
      try {
        await access(file, constants.X_OK)
        return file
      } catch {}
    }
  }
  return undefined
}

// ── 版本、登录与更新（设置页） ─────────────────────────

/** `2.1.296 (Claude Code)`、`codex-cli 0.162.1` 里的版本号 */
export function versionOf(text: string | undefined): string | undefined {
  const m = text?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return m && semver.valid(m[0]) ? m[0] : undefined
}

/**
 * 该提示更新到哪个版本：只有更新的版本才算。
 * Claude Code 的本地版本已经领先 latest 时（用户在 next 通道），把 next 也纳入比较。
 */
export function newerVersion(
  id: CliKind,
  local: string | undefined,
  tags: Record<string, string>,
): string | undefined {
  const latest = semver.valid(tags.latest)
  if (!latest) return undefined
  let target = latest
  const next = semver.valid(tags.next)
  if (id === 'claude' && local && next && semver.gt(local, latest) && semver.gt(next, target))
    target = next
  return local && semver.gt(target, local) ? target : undefined
}

const TAGS_TTL_MS = 30 * 60 * 1000
const tagsCache = new Map<string, { at: number; tags: Promise<Record<string, string> | null> }>()

/** npm 上的 dist-tags；查不到（离线、超时）时返回 null，半小时内复用 */
function distTags(pkg: string, force = false) {
  const hit = tagsCache.get(pkg)
  if (hit && !force && Date.now() - hit.at < TAGS_TTL_MS) return hit.tags
  const tags = fetch(`https://registry.npmjs.org/-/package/${pkg}/dist-tags`, {
    signal: AbortSignal.timeout(8_000),
  })
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, string>>) : null))
    .catch(() => null)
  tagsCache.set(pkg, { at: Date.now(), tags })
  return tags
}

/** 登录状态：claude auth status 输出 JSON；codex login status 用退出码 */
async function loggedIn(id: CliKind, bin: string, path: string): Promise<boolean | null> {
  const env = { ...process.env, PATH: path }
  if (id === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) return true
    try {
      const { stdout } = await exec(bin, ['auth', 'status'], { timeout: 10_000, env })
      const v = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn
      return typeof v === 'boolean' ? v : null
    } catch (err) {
      // 没登录时也会输出 JSON、退出码非 0
      const out = (err as { stdout?: string }).stdout
      try {
        const v = (JSON.parse(out ?? '') as { loggedIn?: unknown }).loggedIn
        return typeof v === 'boolean' ? v : null
      } catch {
        return null
      }
    }
  }
  try {
    await exec(bin, ['login', 'status'], { timeout: 10_000, env })
    return true
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean }
    return typeof e.code === 'number' && !e.killed ? false : null
  }
}

interface UpdateCommand {
  args: string[]
  env?: Record<string, string>
}

/** 按安装方式更新；Codex standalone 重跑官方安装器，保留原来的包目录与命令入口。 */
async function updateCommandOf(id: CliKind, bin: string): Promise<UpdateCommand | undefined> {
  const real = await realpath(bin).catch(() => bin)
  if (real.includes(`${sep}Caskroom${sep}`) || real.includes(`${sep}Cellar${sep}`)) {
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((b) =>
      real.startsWith(dirname(dirname(b))),
    )
    const formula = id === 'claude' ? 'claude-code' : 'codex'
    return { args: [brew ?? 'brew', 'upgrade', formula] }
  }
  const marker = `${sep}lib${sep}node_modules${sep}`
  const i = real.indexOf(marker)
  if (i >= 0) {
    // <prefix>/lib/node_modules/<pkg>/... → <prefix>/bin/npm，和装它的那份 npm 一致
    const npm = join(real.slice(0, i), 'bin', 'npm')
    const ok = await access(npm, constants.X_OK).then(
      () => true,
      () => false,
    )
    return { args: [ok ? npm : 'npm', 'install', '-g', `${SPECS[id].pkg}@latest`] }
  }
  if (id === 'claude') return { args: [bin, 'update'] }
  const codexHome =
    process.platform !== 'win32'
      ? real.match(/^(.*)\/packages\/standalone\/releases\/[^/]+\/(?:bin\/)?codex$/)?.[1]
      : undefined
  if (codexHome) {
    const installDir = dirname(bin)
    const realDir = await realpath(installDir).catch(() => installDir)
    const standalone = join(codexHome, 'packages', 'standalone')
    // 安装器会替换命令入口；直接调用 current/release 内的二进制时不能覆盖包自身。
    if ([installDir, realDir].some((d) => d === standalone || d.startsWith(standalone + sep)))
      return undefined
    return {
      args: [
        'bash',
        '-o',
        'pipefail',
        '-c',
        'curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release latest',
      ],
      env: {
        CODEX_HOME: codexHome,
        CODEX_INSTALL_DIR: installDir,
        CODEX_NON_INTERACTIVE: '1',
      },
    }
  }
  return undefined
}

const quote = (parts: string[]) =>
  parts
    .map((p) =>
      /^[\w./:@=+-]+$/.test(p)
        ? p
        : process.platform === 'win32'
          ? JSON.stringify(p)
          : `'${p.replaceAll("'", "'\\''")}'`,
    )
    .join(' ')

/** 设置页用：每个 CLI 的安装、登录、版本和能否一键更新 */
export async function cliDetails(refresh = false): Promise<LocalCliInfo[]> {
  const env = await detectClis(refresh)
  return Promise.all(KINDS.map((id) => detailOf(id, env, refresh)))
}

async function detailOf(id: CliKind, env: CliEnvironment, refresh: boolean) {
  const spec = SPECS[id]
  const cli = env.agents.find((a) => a.id === id)
  const base = { id, name: spec.name, installCommand: spec.install, loginCommand: spec.login }
  if (!cli?.path) return { ...base, installed: false, loggedIn: null, updateAvailable: false }
  const version = versionOf(cli.version)
  const [tags, login, update] = await Promise.all([
    distTags(spec.pkg, refresh),
    loggedIn(id, cli.path, env.path),
    updateCommandOf(id, cli.path),
  ])
  const newer = tags ? newerVersion(id, version, tags) : undefined
  return {
    ...base,
    installed: true,
    version: version ?? cli.version,
    path: cli.path,
    loggedIn: login,
    ...(tags?.latest ? { latest: newer ?? tags.latest } : {}),
    updateAvailable: !!newer,
    ...(update
      ? {
          updateCommand: quote([
            ...(update.env
              ? ['env', ...Object.entries(update.env).map(([k, v]) => `${k}=${v}`)]
              : []),
            ...update.args,
          ]),
        }
      : {}),
  } satisfies LocalCliInfo
}

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000
const updating = new Map<CliKind, Promise<LocalCliUpdateResult>>()

/** 运行更新命令；同一个 CLI 同时只跑一次。结束后重新检测版本 */
export function updateCli(id: CliKind): Promise<LocalCliUpdateResult> {
  let p = updating.get(id)
  if (!p) {
    p = runUpdate(id).finally(() => updating.delete(id))
    updating.set(id, p)
  }
  return p
}

async function runUpdate(id: CliKind): Promise<LocalCliUpdateResult> {
  const env = await detectClis(true)
  const cli = env.agents.find((a) => a.id === id)
  const cmd = cli?.path ? await updateCommandOf(id, cli.path) : undefined
  if (!cmd) {
    const info = await detailOf(id, env, false)
    return { ok: false, output: `没法自动更新 ${SPECS[id].name}，请在终端里手动更新。`, cli: info }
  }
  const { ok, output } = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    let out = ''
    const child = spawn(cmd.args[0]!, cmd.args.slice(1), {
      env: { ...process.env, PATH: env.path, CI: '1', ...cmd.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-4000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGTERM'), UPDATE_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, output: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: out.trim() })
    })
  })
  const fresh = await detectClis(true)
  return { ok, output: output.slice(-1500), cli: await detailOf(id, fresh, true) }
}

export const cliName = (id: CliKind) => SPECS[id].name
export const isCliKind = (id: string): id is CliKind => id in SPECS

import { execFile } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentCli, AgentKind } from '@plein/protocol'

const exec = promisify(execFile)

const NAMES: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' }

/** 常见安装位置：从 Finder / Dock 打开的桌面端拿不到 shell 里的 PATH */
const COMMON_DIRS = [
  join(homedir(), '.local/bin'),
  join(homedir(), '.claude/local'),
  join(homedir(), '.npm-global/bin'),
  join(homedir(), '.bun/bin'),
  join(homedir(), '.volta/bin'),
  join(homedir(), 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

export interface ResolvedCli extends AgentCli {
  path?: string
}

export interface CliEnvironment {
  /** 启动智能体时用的 PATH（登录 shell 的 PATH + 常见目录） */
  path: string
  agents: ResolvedCli[]
}

let cached: Promise<CliEnvironment> | null = null

/** 找本机的 claude / codex；结果缓存，force 时重新检测（用户刚装好） */
export function detectClis(force = false): Promise<CliEnvironment> {
  if (force || !cached) cached = detect()
  return cached
}

async function detect(): Promise<CliEnvironment> {
  const path = mergePath(
    await loginShellPath(),
    process.env.PATH ?? '',
    COMMON_DIRS.join(delimiter),
  )
  const agents = await Promise.all(
    (Object.keys(NAMES) as AgentKind[]).map(async (id): Promise<ResolvedCli> => {
      const bin = await which(id, path)
      if (!bin) return { id, name: NAMES[id], available: false }
      const version = await exec(bin, ['--version'], {
        timeout: 10_000,
        env: { ...process.env, PATH: path },
      })
        .then((r) => r.stdout.trim().split('\n')[0])
        .catch(() => undefined)
      return { id, name: NAMES[id], available: true, version, path: bin }
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

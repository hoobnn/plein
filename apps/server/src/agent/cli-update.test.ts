import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { cliDetails, updateCli } from './cli'

let root: string
let commands: string
let versionFile: string

function executable(path: string, source: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${source}\n`)
  chmodSync(path, 0o755)
  return path
}

function codex(path: string) {
  executable(
    path,
    `if [ "$1" = --version ]; then
  printf 'codex-cli '
  cat "$PLEIN_TEST_VERSION"
fi`,
  )
  symlinkSync(path, join(commands, 'codex'))
}

function standalone(legacy = false) {
  const home = join(root, "custom home '$codex;`dir`")
  const base = join(home, 'packages/standalone')
  const release = join(base, 'releases/0.162.1-aarch64-apple-darwin')
  const relative = legacy ? 'codex' : 'bin/codex'
  executable(join(release, relative), 'exit 0')
  symlinkSync(release, join(base, 'current'))
  // 经 current 间接解析到 release，和官方安装器生成的入口一致。
  codex(join(base, 'current', relative))
  return { home, base, release, relative }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plein-cli-update-')))
  commands = join(root, 'custom bin')
  mkdirSync(commands)
  versionFile = join(root, 'version')
  writeFileSync(versionFile, '0.162.1\n')
  vi.stubEnv('PLEIN_TEST_VERSION', versionFile)
  vi.stubEnv('PLEIN_TEST_DOWNLOAD_LOG', join(root, 'download.log'))
  vi.stubEnv('PLEIN_TEST_INSTALL_LOG', join(root, 'install.log'))
  vi.stubEnv('PLEIN_TEST_CURL_FAIL', '')
  vi.stubEnv('CODEX_HOME', join(root, 'unrelated home'))
  vi.stubEnv('CODEX_INSTALL_DIR', join(root, 'unrelated bin'))
  vi.stubEnv('CODEX_RELEASE', '0.100.0')
  vi.stubEnv('CODEX_NON_INTERACTIVE', '')
  // 隔离登录 shell 的 PATH，检测和更新都只会命中本测试的 CLI 与下载器。
  vi.stubEnv('PATH', [commands, '/usr/bin', '/bin'].join(delimiter))
  vi.stubEnv('SHELL', executable(join(root, 'shell'), `printf '__PLEIN_PATH__%s' "$PATH"`))
  executable(
    join(commands, 'claude'),
    `if [ "$1" = --version ]; then
  printf '2.1.296 (Claude Code)\\n'
else
  printf '{"loggedIn":true}\\n'
fi`,
  )
  executable(
    join(commands, 'curl'),
    `printf '%s\\n' "$CODEX_HOME" "$CODEX_INSTALL_DIR" "$CODEX_NON_INTERACTIVE" "$*" > "$PLEIN_TEST_DOWNLOAD_LOG"
if [ "$PLEIN_TEST_CURL_FAIL" = 1 ]; then
  printf 'curl: simulated download failure\\n' >&2
  exit 22
fi
cat <<'INSTALLER'
printf '%s\\n' "$*" > "$PLEIN_TEST_INSTALL_LOG"
printf '0.163.0\\n' > "$PLEIN_TEST_VERSION"
printf 'Updated Codex\\n'
INSTALLER`,
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json({ latest: url.includes('@openai/codex') ? '0.163.0' : '2.1.296' }),
    ),
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('本机 CLI 更新', () => {
  it.each([false, true])(
    '识别 standalone（legacy=%s），保留自定义目录并刷新版本',
    async (legacy) => {
      const { home } = standalone(legacy)
      const details = (await cliDetails(true)).find((c) => c.id === 'codex')!
      expect(details).toMatchObject({
        installed: true,
        version: '0.162.1',
        latest: '0.163.0',
        path: join(commands, 'codex'),
        updateAvailable: true,
        updateCommand: expect.stringContaining('https://chatgpt.com/codex/install.sh'),
      })
      expect(existsSync(join(root, 'download.log'))).toBe(false)

      // 真正 spawn 更新命令，但 curl 和安装器均为本地替身，不联网也不修改已安装的工具。
      const result = await updateCli('codex')
      expect(result).toMatchObject({
        ok: true,
        output: 'Updated Codex',
        cli: { version: '0.163.0', updateAvailable: false, path: join(commands, 'codex') },
      })
      expect(readFileSync(join(root, 'download.log'), 'utf8').split('\n')).toEqual([
        home,
        commands,
        '1',
        '-fsSL https://chatgpt.com/codex/install.sh',
        '',
      ])
      expect(readFileSync(join(root, 'install.log'), 'utf8').trim()).toBe('--release latest')
      expect(existsSync(join(root, 'unrelated home'))).toBe(false)
      expect(existsSync(join(root, 'unrelated bin'))).toBe(false)
      // 按钮提示里的命令也能复现相同环境，不会把目录中的 shell 符号解释成命令。
      execFileSync('bash', ['-c', details.updateCommand!])
      expect(readFileSync(join(root, 'download.log'), 'utf8').split('\n').slice(0, 3)).toEqual([
        home,
        commands,
        '1',
      ])
    },
  )

  it('下载失败时返回失败与原版本，不执行安装器', async () => {
    standalone()
    vi.stubEnv('PLEIN_TEST_CURL_FAIL', '1')
    const result = await updateCli('codex')
    expect(result).toMatchObject({
      ok: false,
      output: expect.stringContaining('simulated download failure'),
      cli: { version: '0.162.1', updateAvailable: true },
    })
    expect(existsSync(join(root, 'install.log'))).toBe(false)
  })

  it.each(['current', 'release', 'directory-symlink'] as const)(
    '不覆盖 standalone 包里的二进制入口：%s',
    async (location) => {
      const { base, release } = standalone()
      rmSync(join(commands, 'codex'))
      const bin = join(location === 'release' ? release : join(base, 'current'), 'bin')
      if (location === 'directory-symlink') {
        const alias = join(root, 'bin-alias')
        symlinkSync(bin, alias)
        vi.stubEnv('PATH', [alias, process.env.PATH].join(delimiter))
      } else {
        vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter))
      }
      const info = (await cliDetails(true)).find((c) => c.id === 'codex')!
      expect(info).toMatchObject({ installed: true, version: '0.162.1', updateAvailable: true })
      expect(info.updateCommand).toBeUndefined()
      expect((await updateCli('codex')).ok).toBe(false)
      expect(existsSync(join(root, 'download.log'))).toBe(false)
    },
  )

  it('Homebrew 仍使用 brew 更新', async () => {
    codex(join(root, 'Caskroom/codex/0.162.1/codex'))
    const info = (await cliDetails(true)).find((c) => c.id === 'codex')!
    expect(info.updateCommand).toBe('brew upgrade codex')
  })

  it('npm 全局安装仍使用同一 prefix 的 npm，并正确引用含特殊字符的路径', async () => {
    const prefix = join(root, "node '$prefix;`bin`")
    executable(join(prefix, 'bin/npm'), `printf '%s\\n' "$*" > "$PLEIN_TEST_INSTALL_LOG"`)
    codex(join(prefix, 'lib/node_modules/@openai/codex/bin/codex.js'))
    const info = (await cliDetails(true)).find((c) => c.id === 'codex')!
    execFileSync('bash', ['-c', info.updateCommand!])
    expect(readFileSync(join(root, 'install.log'), 'utf8').trim()).toBe(
      'install -g @openai/codex@latest',
    )
  })

  it('未知的 Codex 二进制不推测安装来源，Claude 继续使用自己的 update', async () => {
    codex(join(root, 'other/codex'))
    const details = await cliDetails(true)
    expect(details.find((c) => c.id === 'codex')?.updateCommand).toBeUndefined()
    expect(details.find((c) => c.id === 'claude')?.updateCommand).toBe(
      `'${join(commands, 'claude')}' update`,
    )
  })
})

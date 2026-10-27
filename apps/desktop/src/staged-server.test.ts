import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vite-plus/test'

it('独立 stage 的 ESM 服务端可加载 TOS CommonJS 运行时并提供会话', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'plein-staged-server-'))
  const staged = join(scratch, 'server')
  const script = fileURLToPath(new URL('../scripts/stage-server.mjs', import.meta.url))
  let child: ReturnType<typeof spawn> | undefined
  let closed: Promise<unknown> | undefined
  try {
    execFileSync(process.execPath, [script, staged], { timeout: 30_000, stdio: 'pipe' })
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('PLEIN_')),
    )
    child = spawn(process.execPath, [join(staged, 'main.mjs')], {
      cwd: scratch,
      env: {
        ...env,
        PLEIN_HOST: '127.0.0.1',
        PLEIN_PORT: '0',
        PLEIN_DATA_DIR: join(scratch, 'data'),
        PLEIN_WEB_DIST: join(scratch, 'missing-web'),
        PLEIN_AUTH: 'none',
        PLEIN_AGENT: '0',
        PLEIN_MCP: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    closed = once(child, 'close')
    let log = ''
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stage 启动超时：${log}`)), 15_000)
      const read = (data: Buffer) => {
        log += data.toString()
        const match = /plein 已启动：(http:\/\/127\.0\.0\.1:\d+)/.exec(log)
        if (match) {
          clearTimeout(timer)
          resolve(match[1]!)
        }
      }
      child!.stdout!.on('data', read)
      child!.stderr!.on('data', read)
      child!.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child!.once('close', () => {
        clearTimeout(timer)
        reject(new Error(`stage 提前退出：${log}`))
      })
    })
    const response = await fetch(`${origin}/api/session`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      principal: { id: 'local', role: 'owner' },
      authRequired: false,
    })
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5_000)
      await closed
      clearTimeout(timer)
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60_000)

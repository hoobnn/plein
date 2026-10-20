import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it, onTestFinished } from 'vite-plus/test'
import { tempDir } from '../testing'

it('真实SIGKILL后原请求UUID仍在SQLite，重启核查不发送第二次请求', async () => {
  const dataDir = tempDir('submission-sigkill-')
  let requests = 0
  let received!: (requestId: string) => void
  const reached = new Promise<string>((resolve) => {
    received = resolve
  })
  const local = createServer((req, _res) => {
    requests++
    req.resume()
    received(String(req.headers['x-api-request-id']))
    // 故意不发响应，确保杀进程时尚未进入 catch。
  })
  local.listen(0, '127.0.0.1')
  await once(local, 'listening')
  onTestFinished(() => {
    local.closeAllConnections()
    local.close()
  })
  const address = local.address()
  if (!address || typeof address === 'string') throw new Error('missing local server')
  const children: ChildProcess[] = []
  onTestFinished(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
  })
  const start = (mode: string) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        fileURLToPath(new URL('./fixtures/submission-crash.child.ts', import.meta.url)),
        dataDir,
        `http://127.0.0.1:${address.port}/submission`,
        mode,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    children.push(child)
    let output = ''
    child.stdout!.on('data', (data) => {
      output += String(data)
    })
    child.stderr!.on('data', (data) => {
      output += String(data)
    })
    return { child, output: () => output }
  }
  const first = start('start')
  const requestId = await Promise.race([
    reached,
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`child failed to submit: ${first.output()}`)),
        10000,
      )
      timeout.unref()
    }),
  ])
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  const before = new Database(join(dataDir, 'plein.db'), { readonly: true })
  const persisted = before
    .prepare('SELECT calls,call_history FROM jobs WHERE id=?')
    .get('crash-job') as { calls: string; call_history: string }
  expect(JSON.parse(persisted.calls).speech).toMatchObject({
    state: 'submitting',
    trace: { requestId },
  })
  expect(JSON.parse(persisted.call_history)).toContainEqual(
    expect.objectContaining({ kind: 'submit_started', requestId }),
  )
  before.close()
  const killed = once(first.child, 'exit')
  first.child.kill('SIGKILL')
  expect(await killed).toEqual([null, 'SIGKILL'])
  const second = start('recover')
  const [code] = await once(second.child, 'exit')
  expect(code, second.output()).toBe(0)
  expect(second.output()).toContain('无法判断是否已受理')
  expect(requests).toBe(1)
  const after = new Database(join(dataDir, 'plein.db'), { readonly: true })
  const restored = after.prepare('SELECT calls,call_history FROM jobs WHERE id=?').get('crash-job')
  expect(restored).toEqual(persisted)
  after.close()
}, 20000)

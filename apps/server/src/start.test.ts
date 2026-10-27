import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vite-plus/test'
import { startTestServer } from './testing'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { resolve, promise }
}

it('关停先完成在途 HTTP 读取，再关闭数据库，同端口重启不复用旧连接', async () => {
  const running = await startTestServer()
  const entered = deferred()
  const resume = deferred()
  running.server.app.get('/shutdown-probe', async (c) => {
    entered.resolve()
    await resume.promise
    return c.json(running.server.db.$client.prepare('SELECT 1 AS value').get())
  })
  const response = fetch(`${running.base}/shutdown-probe`)
  await entered.promise
  const closing = running.close()
  try {
    expect(running.close()).toBe(closing)
    // 让关停任务经过异步清理；请求仍在真实 HTTP 连接上等待。
    await setImmediate()
    resume.resolve()
    const result = await response
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({ value: 1 })
  } finally {
    resume.resolve()
    await response
    await closing
  }
  expect(running.server.db.$client.open).toBe(false)
  const restarted = await startTestServer({
    dataDir: running.dataDir,
    config: { port: running.port },
  })
  const session = await fetch(`${restarted.base}/api/session`)
  expect(session.status).toBe(200)
  expect(await session.json()).toMatchObject({ principal: { role: 'owner' } })
})

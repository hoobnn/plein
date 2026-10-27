import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, request, tempDir } from '../testing'

const example = resolve(import.meta.dirname, '../../../../examples/plugins/acme-echo')

/** 保留真实的 describe：只有 execute 让子进程退出，才触发宿主的崩溃限额 */
const CRASH = `process.prependListener('message', (message) => {
  if (message?.t === 'req' && message.method === 'execute') process.exit(42)
})
`

describe('插件反复崩溃的限额', () => {
  it('连续崩溃到上限就停下并标成出错，修好重新加载后还能真实执行', async () => {
    const dataDir = tempDir('plein-crash-')
    execFileSync(
      process.execPath,
      [join(example, 'build.mjs'), join(dataDir, 'plugins/acme-echo')],
      {
        stdio: 'inherit',
      },
    )
    const entry = join(dataDir, 'plugins/acme-echo/dist/server.mjs')
    const original = readFileSync(entry, 'utf8')
    const f = await bootServer({ dataDir })
    const run = (text: string) =>
      f.server.plugins.runNode({
        type: 'acme/shout',
        version: 1,
        params: { text },
        ownerId: 'local',
      })
    try {
      writeFileSync(entry, `${original}\n${CRASH}`)
      const enabled = await request(f.server, '/api/plugins/local/acme/echo', {
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
      })
      expect(await enabled.json()).toMatchObject({ status: 'active' })

      // 每一次都让子进程真的退出：到上限后宿主不再拉起它
      for (let attempt = 0; attempt < 3; attempt++) await expect(run('boom')).rejects.toThrow()
      const broken = (await (await request(f.server, '/api/plugins/local')).json()) as Array<{
        id: string
        status: string
        error?: string
      }>
      expect(broken.find((p) => p.id === 'acme/echo')).toMatchObject({ status: 'error' })
      expect(broken.find((p) => p.id === 'acme/echo')?.error).toContain('插件反复崩溃')

      // 修好入口再重新加载：崩溃计数归零，节点又能跑
      writeFileSync(entry, original)
      const reload = await request(f.server, '/api/plugins/local/acme/echo/reload', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      expect(await reload.json()).toMatchObject({ status: 'active' })
      expect(await run('crash recovery')).toEqual({
        text: [{ type: 'text', text: 'CRASH RECOVERY!' }],
      })
    } finally {
      writeFileSync(entry, original)
    }
  }, 60_000)
})

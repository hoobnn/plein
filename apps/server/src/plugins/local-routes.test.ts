import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, request, tempDir } from '../testing'
import { ExternalPlugins } from './external'
import { localPluginRoutes } from './routes'

const example = resolve(import.meta.dirname, '../../../../examples/plugins/acme-echo')

/** 把示例插件打进数据目录的 plugins/：服务启动时就扫到它 */
function seed(dataDir: string) {
  execFileSync(process.execPath, [join(example, 'build.mjs'), join(dataDir, 'plugins/acme-echo')], {
    stdio: 'inherit',
  })
}

async function boot() {
  const dataDir = tempDir('plein-local-routes-')
  seed(dataDir)
  const f = await bootServer({ dataDir })
  return { ...f, dataDir }
}

type Plugin = { id: string; enabled: boolean; status: string }

const list = async (f: Awaited<ReturnType<typeof boot>>) =>
  (await (await request(f.server, '/api/plugins/local')).json()) as Plugin[]

const catalogNodes = async (f: Awaited<ReturnType<typeof boot>>) =>
  ((await (await request(f.server, '/api/catalog')).json()) as { nodes: Array<{ type: string }> })
    .nodes

const enable = (f: Awaited<ReturnType<typeof boot>>, enabled: boolean) =>
  request(f.server, '/api/plugins/local/acme/echo', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })

describe('本机插件 HTTP 合同', () => {
  it('默认禁用且不进目录；启用后节点进目录，停用后撤下', async () => {
    const f = await boot()
    expect(await list(f)).toMatchObject([{ id: 'acme/echo', enabled: false, status: 'disabled' }])
    expect((await catalogNodes(f)).some((n) => n.type === 'acme/shout')).toBe(false)

    const enabled = await enable(f, true)
    expect(enabled.status).toBe(200)
    expect(await enabled.json()).toMatchObject({ id: 'acme/echo', enabled: true, status: 'active' })
    expect((await catalogNodes(f)).some((n) => n.type === 'acme/shout')).toBe(true)

    const disabled = await enable(f, false)
    expect(disabled.status).toBe(200)
    expect((await catalogNodes(f)).some((n) => n.type === 'acme/shout')).toBe(false)
  }, 30_000)

  it('重新加载和重新扫描都返回列表；启用意图落盘后重启仍然启用', async () => {
    const f = await boot()
    await enable(f, true)
    const reload = await request(f.server, '/api/plugins/local/acme/echo/reload', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(reload.status).toBe(200)
    expect(await reload.json()).toMatchObject({ id: 'acme/echo', enabled: true, status: 'active' })

    const rescan = await request(f.server, '/api/plugins/local/rescan', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(rescan.status).toBe(200)
    expect((await rescan.json()) as unknown[]).toHaveLength(1)

    // 启用意图写进数据目录：重启后服务端仍按这个意图把插件拉起来
    const again = await bootServer({ dataDir: f.dataDir })
    expect(await list(again)).toMatchObject([{ id: 'acme/echo', enabled: true, status: 'active' }])
  }, 60_000)

  it('插件不存在是 404，请求体不对是 400', async () => {
    const f = await boot()
    const missing = await request(f.server, '/api/plugins/local/acme/nope', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    expect(missing.status).toBe(404)
    const missingReload = await request(f.server, '/api/plugins/local/acme/nope/reload', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(missingReload.status).toBe(404)
    const invalid = await request(f.server, '/api/plugins/local/acme/echo', {
      method: 'PUT',
      body: JSON.stringify({}),
    })
    expect(invalid.status).toBe(400)
  })

  it('只有所有者能启用、停用和重新加载', async () => {
    const f = await boot()
    const ext = new ExternalPlugins(
      f.server.plugins,
      join(f.dataDir, 'plugins'),
      join(f.dataDir, 'plugins-state.json'),
    )
    await ext.init()
    const viewer = new Hono<AuthEnv>()
    viewer.use('*', async (c, next) => {
      c.set('principal', { id: 'v', role: 'viewer' })
      await next()
    })
    viewer.route('/', localPluginRoutes(ext))
    // 读接口对所有人开放
    expect((await viewer.request('/api/plugins/local')).status).toBe(200)
    for (const [path, method] of [
      ['/api/plugins/local/acme/echo', 'PUT'],
      ['/api/plugins/local/acme/echo/reload', 'POST'],
      ['/api/plugins/local/rescan', 'POST'],
    ] as const)
      expect((await viewer.request(path, { method, body: '{}' })).status).toBe(403)
    ext.close()
  })

  it('清单损坏的插件照样按原身份列出来但标成出错，不进目录', async () => {
    const f = await boot()
    // 把已装好的插件清单写坏：身份还得认得出来，否则用户没法再停用或修复它
    writeFileSync(join(f.dataDir, 'plugins/acme-echo/plein-plugin.json'), '{ invalid json')
    await request(f.server, '/api/plugins/local/rescan', { method: 'POST', body: '{}' })
    const plugins = await list(f)
    expect(plugins.find((p) => p.id === 'acme/echo')).toMatchObject({ status: 'error' })
    expect(plugins.some((p) => p.id === 'acme-echo')).toBe(false)
    expect((await catalogNodes(f)).some((n) => n.type === 'acme/shout')).toBe(false)
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import { openDb } from '../storage/db'
import { tempDir } from '../testing'
import { AssetStore } from '../assets/store'
import { ProviderConfigStore } from './config-store'
import { builtinPlugins } from './builtin'
import { ExternalPlugins } from './external'
import { PluginHost } from './host'
import { PluginRegistry } from './registry'

const example = resolve(import.meta.dirname, '../../../../examples/plugins/acme-echo')

let root = ''
let http: Server
let base = ''
let host: PluginHost
let plugins: ExternalPlugins

beforeAll(async () => {
  const dir = tempDir('plein-ext-')
  root = join(dir, 'plugins')
  // 示例插件打成单文件，放进数据目录的 plugins/
  execFileSync(process.execPath, [join(example, 'build.mjs'), join(root, 'acme-echo')], {
    stdio: 'inherit',
  })
  // 清单不对的插件：照样列出来，标成出错
  mkdirSync(join(root, 'broken'))
  writeFileSync(join(root, 'broken', 'plein-plugin.json'), '{"id":"bad"}')

  http = createServer((req, res) => {
    if (req.url === '/ping') return res.end('ok')
    if (req.headers.authorization !== 'Bearer k') {
      res.statusCode = 401
      return res.end()
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ text: `回声：${JSON.parse(body).text}` }))
    })
  })
  // 不指定地址：IPv4、IPv6 都监听，localhost 解析到哪个都能连上
  await new Promise<void>((ok) => http.listen(0, ok))
  base = `http://localhost:${(http.address() as { port: number }).port}`

  const db = openDb(dir)
  const assets = new AssetStore(dir, db, 64 * 1024 * 1024)
  await assets.init()
  host = new PluginHost(
    new PluginRegistry(),
    new ProviderConfigStore(dir, new Set(['plein/mock'])),
    assets,
    {
      log: () => {},
      // 用全局 fetch：容器里 Node 自带的 undici 和依赖里的 Agent 版本可能对不上
      fetch: globalThis.fetch,
    },
  )
  // 内置的 Mock 平台：模型带 options（zod），执行时要能带进子进程
  host.load(builtinPlugins({ mock: true }), true)
  plugins = new ExternalPlugins(host, root, join(dir, 'plugins.json'))
  await plugins.init()
}, 60_000)

afterAll(() => {
  plugins?.close()
  http?.close()
})

const run = (type: string, params: Record<string, unknown>) =>
  host.runNode({ type, version: 1, params, ownerId: 'local' })

describe('本机第三方插件', () => {
  it('默认不启用：列出来但不进目录；清单不对的标成出错', () => {
    const list = plugins.list()
    expect(list.find((p) => p.id === 'acme/echo')).toMatchObject({
      status: 'disabled',
      enabled: false,
      permissions: { network: ['localhost'], secrets: ['ACME_ECHO_KEY'] },
    })
    expect(list.find((p) => p.id === 'broken')?.status).toBe('error')
    expect(host.registry.latestNode('acme/shout')).toBeUndefined()
  })

  it('启用后在子进程里运行：节点、平台、预设进目录，执行器能跑', async () => {
    const info = await plugins.setEnabled('acme/echo', true)
    expect(info).toMatchObject({ status: 'active' })
    // 权限模型生效：子进程不能写文件
    expect(info?.sandbox).toMatchObject({ permission: true, fsWrite: false })
    expect(host.registry.latestNode('acme/shout')).toBeTruthy()
    expect(host.registry.prompts.has('acme/cheer')).toBe(true)
    // 参数照 schema 校验、补默认值
    expect(await run('acme/shout', { text: 'hello', marks: 2 })).toEqual({
      text: [{ type: 'text', text: 'HELLO!!' }],
    })
    await expect(run('acme/shout', { marks: 9 })).rejects.toThrow(/参数不正确/)
  }, 30_000)

  it('平台经宿主代发请求：密钥按清单给，未声明的域名被拦下', async () => {
    host.configs.update('acme/echo', {
      enabled: true,
      settings: { baseUrl: base },
      secrets: { ACME_ECHO_KEY: 'k' },
    })
    await host.testProvider('acme/echo', 'local')
    const out = await run('acme/ask', { model: 'acme/echo:echo-1', prompt: '你好' })
    expect(out.text?.[0]).toEqual({ type: 'text', text: '回声：你好' })

    host.configs.update('acme/echo', { settings: { baseUrl: 'http://example.com' } })
    await expect(run('acme/ask', { model: 'acme/echo:echo-1', prompt: '你好' })).rejects.toThrow(
      /没有声明访问 example.com/,
    )
  }, 30_000)

  it('停用后从目录里拿掉，重新启用和重新加载都能恢复', async () => {
    await plugins.setEnabled('acme/echo', false)
    expect(host.registry.latestNode('acme/shout')).toBeUndefined()
    expect(host.registry.plugin('acme/echo')).toBeUndefined()
    await plugins.setEnabled('acme/echo', true)
    expect((await plugins.reload('acme/echo'))?.status).toBe('active')
    expect(await run('acme/shout', { text: 'ok' })).toEqual({
      text: [{ type: 'text', text: 'OK!' }],
    })
  }, 30_000)
})

it.each(['reload', 'disable'] as const)('损坏清单后保留插件身份，可 %s 恢复', async (action) => {
  const manifest = join(root, 'acme-echo', 'plein-plugin.json')
  const original = readFileSync(manifest, 'utf8')
  try {
    await plugins.setEnabled('acme/echo', true)
    writeFileSync(manifest, '{ invalid json')
    const broken = await plugins.reload('acme/echo')
    expect(broken).toMatchObject({ id: 'acme/echo', enabled: true, status: 'error' })
    expect(broken?.error).toContain('清单读不出来')
    expect(plugins.list().some((plugin) => plugin.id === 'acme-echo')).toBe(false)
    expect(host.registry.latestNode('acme/shout')).toBeUndefined()
    if (action === 'disable') {
      expect(await plugins.setEnabled('acme/echo', false)).toMatchObject({
        enabled: false,
        status: 'error',
      })
    }
    writeFileSync(manifest, original)
    if (action === 'reload')
      expect(await plugins.reload('acme/echo')).toMatchObject({ enabled: true, status: 'active' })
    else {
      plugins.scan()
      expect(await plugins.setEnabled('acme/echo', true)).toMatchObject({
        enabled: true,
        status: 'active',
      })
    }
    expect(await run('acme/shout', { text: 'repaired' })).toEqual({
      text: [{ type: 'text', text: 'REPAIRED!' }],
    })
  } finally {
    writeFileSync(manifest, original)
    plugins.scan()
    await plugins.setEnabled('acme/echo', false)
  }
})

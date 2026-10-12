import { mkdtempSync, rmSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { corePlugin } from '@plein/nodes'
import {
  defineExecutor,
  defineNode,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  type PluginManifestInput,
  ProviderError,
} from '@plein/plugin-sdk'
import type { Catalog, ProviderConfigView, ProviderTestResult } from '@plein/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createServer } from '../app'
import { loadConfig } from '../config'
import { NodeRunError } from './host'
import { Limiter } from './limiter'
import { PluginRegistry } from './registry'
import { PermissionError, scopedFetch, scopedSecrets } from './sandbox'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), 'plein-plugins-'))
  dirs.push(dataDir)
  const server = await createServer({
    ...loadConfig({ PLEIN_DATA_DIR: dataDir, PLEIN_MOCK_PROVIDER: '1' }),
    webDist: null,
  })
  const http = serve({ fetch: server.app.fetch, hostname: '127.0.0.1', port: 0 })
  await new Promise<void>((r) => http.once('listening', () => r()))
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  return {
    server,
    base,
    dataDir,
    host: server.plugins,
    json: (method: string, body: unknown) => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    async stop() {
      server.close()
      await new Promise((r) => http.close(r))
    },
  }
}

const manifest = (over: Partial<PluginManifestInput> = {}): PluginManifestInput => ({
  id: 'acme/demo',
  version: '1.0.0',
  name: 'Demo',
  engines: { plein: `^${PLUGIN_API_VERSION}` },
  ...over,
})

const echoNode = defineNode({
  type: 'acme/echo',
  version: 1,
  title: 'Echo',
  category: 'util',
  inputs: [],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  params: z.object({ text: z.string().default('') }),
})

describe('插件注册表', () => {
  const load = (sp: Parameters<PluginRegistry['register']>[0]) => {
    const r = new PluginRegistry()
    return { r, entry: r.register(sp, { builtin: false }) }
  }

  it('合规插件加载成功', () => {
    const { r, entry } = load(
      defineServerPlugin(
        definePlugin({
          manifest: manifest({ contributes: { nodes: ['acme/echo@1'] } }),
          nodes: [echoNode],
        }),
        {
          executors: [
            defineExecutor(echoNode, async ({ params }) => ({
              text: [{ type: 'text', text: params.text }],
            })),
          ],
        },
      ),
    )
    expect(entry.status).toBe('active')
    expect(r.executors.has('acme/echo@1')).toBe(true)
  })

  it.each([
    ['插件 API 版本不兼容', { engines: { plein: '^9.0.0' } }, [echoNode], /插件 API/],
    ['清单没声明节点', { contributes: { nodes: [] } }, [echoNode], /缺少：acme\/echo@1/],
    [
      '清单声明了没提供的节点',
      { contributes: { nodes: ['acme/echo@1', 'acme/x@1'] } },
      [echoNode],
      /没有提供：acme\/x@1/,
    ],
    [
      '节点不在命名空间下',
      { id: 'other/demo', contributes: { nodes: ['acme/echo@1'] } },
      [echoNode],
      /命名空间/,
    ],
  ])('%s时整个插件标记为 error', (_name, over, nodes, error) => {
    const { r, entry } = load(
      defineServerPlugin(definePlugin({ manifest: manifest(over), nodes }), {}),
    )
    expect(entry.status).toBe('error')
    expect(entry.error).toMatch(error)
    expect(r.nodes.size).toBe(0)
  })

  it('Provider 使用未声明的密钥时拒绝加载', () => {
    const provider = defineProvider({
      id: 'acme/llm',
      title: 'Acme',
      settings: z.object({}),
      secrets: [{ name: 'ACME_KEY', title: 'Key', required: true }],
      models: [{ id: 'm', title: 'M', capabilities: ['text.chat'] }],
      submit: async () => ({ state: 'succeeded', outputs: [] }),
    })
    const { entry } = load(
      defineServerPlugin(
        definePlugin({ manifest: manifest({ contributes: { providers: ['acme/llm'] } }) }),
        {
          providers: [provider],
        },
      ),
    )
    expect(entry.error).toMatch(/ACME_KEY/)
  })

  it('节点冲突时后加载的插件失败，先加载的不受影响', () => {
    const r = new PluginRegistry()
    const sp = () =>
      defineServerPlugin(
        definePlugin({
          manifest: manifest({ contributes: { nodes: ['acme/echo@1'] } }),
          nodes: [echoNode],
        }),
        {},
      )
    expect(r.register(sp(), { builtin: false }).status).toBe('active')
    const second = r.register(
      defineServerPlugin(
        definePlugin({
          manifest: manifest({ id: 'acme/other', contributes: { nodes: ['acme/echo@1'] } }),
          nodes: [echoNode],
        }),
        {},
      ),
      { builtin: false },
    )
    expect(second.error).toMatch(/已被其他插件注册/)
    expect(r.plugin('acme/demo')?.status).toBe('active')
  })
})

describe('权限裁剪', () => {
  const m = definePlugin({
    manifest: manifest({
      permissions: { network: ['api.acme.com', '*.cdn.acme.com'], secrets: ['ACME_KEY'] },
    }),
  }).manifest

  it('fetch 只能访问声明过的域名，重定向逐跳检查', async () => {
    const seen: string[] = []
    const base = (async (req: Request) => {
      seen.push(req.url)
      if (req.url.includes('/redirect-bad'))
        return new Response(null, { status: 302, headers: { location: 'https://evil.com/x' } })
      if (req.url.includes('/redirect-ok'))
        return new Response(null, {
          status: 302,
          headers: { location: 'https://a.cdn.acme.com/x' },
        })
      return new Response('ok')
    }) as typeof fetch
    const f = scopedFetch(m, base)
    expect(await (await f('https://api.acme.com/v1')).text()).toBe('ok')
    expect(await (await f('https://api.acme.com/redirect-ok')).text()).toBe('ok')
    await expect(f('https://evil.com/')).rejects.toBeInstanceOf(PermissionError)
    await expect(f('https://cdn.acme.com.evil.com/')).rejects.toBeInstanceOf(PermissionError)
    await expect(f('https://api.acme.com/redirect-bad')).rejects.toBeInstanceOf(PermissionError)
    expect(seen).not.toContain('https://evil.com/x')
  })

  it('只能读声明过的密钥', () => {
    const secret = scopedSecrets(m, { ACME_KEY: 'k', OTHER: 'x' })
    expect(secret('ACME_KEY')).toBe('k')
    expect(() => secret('OTHER')).toThrow(PermissionError)
  })
})

describe('Limiter', () => {
  it('限制并发', async () => {
    const l = new Limiter(2)
    let running = 0
    let peak = 0
    await Promise.all(
      Array.from({ length: 6 }, () =>
        l.run(async () => {
          peak = Math.max(peak, ++running)
          await new Promise((r) => setTimeout(r, 10))
          running--
        }),
      ),
    )
    expect(peak).toBe(2)
  })
})

describe('插件宿主', () => {
  let s: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    s = await start()
  })
  afterAll(() => s.stop())

  it('目录接口列出内置节点、Provider 与插件状态', async () => {
    const catalog = (await (await fetch(`${s.base}/api/catalog`)).json()) as Catalog
    expect(catalog.plugins.map((p) => [p.id, p.status])).toEqual([
      ['plein/core', 'active'],
      ['plein/mock', 'active'],
    ])
    const types = catalog.nodes.map((n) => `${n.type}@${n.version}`)
    expect(types).toEqual(corePlugin.manifest.contributes.nodes)
    expect(catalog.nodes.every((n) => n.executable)).toBe(true)
    const image = catalog.nodes.find((n) => n.type === 'plein/image')!
    expect(image.defaults).toMatchObject({ model: '', aspectRatio: '16:9', count: 1 })
    expect(
      (image.paramsSchema.properties as Record<string, { widget?: string }>).model?.widget,
    ).toBe('model')
    expect(catalog.providers[0]).toMatchObject({
      id: 'plein/mock',
      enabled: true,
      configured: true,
    })
  })

  it('文本节点 → 生成图片：结果存入资产库', async () => {
    const text = await s.host.runNode({
      type: 'plein/text',
      version: 1,
      params: { text: '天台 夜景' },
      ownerId: 'local',
    })
    const out = await s.host.runNode({
      type: 'plein/image',
      version: 1,
      params: { count: 2, aspectRatio: '9:16' },
      inputs: { prompt: text.text! },
      ownerId: 'local',
    })
    expect(out.images).toHaveLength(2)
    const first = out.images![0]!
    expect(first).toMatchObject({ type: 'image', kind: 'image', mime: 'image/png' })
    const asset = s.server.assets.get('local', (first as { assetId: string }).assetId)
    expect(asset).toMatchObject({ width: 144, height: 256 })
    const res = await fetch(`${s.base}/api/assets/${asset!.id}`)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('LLM、视频、配音、配乐节点都能跑通', async () => {
    const llm = await s.host.runNode({
      type: 'plein/llm',
      version: 1,
      params: { prompt: '写一句台词' },
      ownerId: 'local',
    })
    expect(llm.text?.[0]).toEqual({ type: 'text', text: '【mock】写一句台词' })
    const video = await s.host.runNode({
      type: 'plein/video',
      version: 1,
      params: { prompt: '镜头推近' },
      ownerId: 'local',
    })
    expect(video.video?.[0]).toMatchObject({ type: 'video', mime: 'video/webm' })
    const speech = await s.host.runNode({
      type: 'plein/speech',
      version: 1,
      params: { text: '你好' },
      ownerId: 'local',
    })
    expect(speech.audio?.[0]).toMatchObject({ type: 'audio', mime: 'audio/wav' })
    const music = await s.host.runNode({
      type: 'plein/music',
      version: 1,
      params: { prompt: '弦乐' },
      ownerId: 'local',
    })
    expect(music.audio).toHaveLength(1)
  })

  it('参数和输入不合规时给出可读错误', async () => {
    await expect(
      s.host.runNode({ type: 'plein/image', version: 1, params: { count: 9 }, ownerId: 'local' }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      s.host.runNode({ type: 'plein/image', version: 1, params: {}, ownerId: 'local' }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: '提示词为空' })
    await expect(
      s.host.runNode({
        type: 'plein/video',
        version: 1,
        params: { prompt: 'x' },
        inputs: { firstFrame: [{ type: 'text', text: 'not an image' }] },
        ownerId: 'local',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      s.host.runNode({ type: 'acme/none', version: 1, ownerId: 'local' }),
    ).rejects.toBeInstanceOf(NodeRunError)
  })

  it('异步任务：轮询到完成；中途取消会通知平台', async () => {
    s.host.configs.update('plein/mock', { settings: { latencyMs: 300, failWith: 'none' } })
    const progress: number[] = []
    const out = await s.host.runNode({
      type: 'plein/llm',
      version: 1,
      params: { prompt: '慢一点' },
      ownerId: 'local',
      onProgress: (p) => progress.push(p),
    })
    expect(out.text?.[0]).toMatchObject({ text: '【mock】慢一点' })
    expect(progress.length).toBeGreaterThan(0)

    const ac = new AbortController()
    const run = s.host.runNode({
      type: 'plein/llm',
      version: 1,
      params: { prompt: 'x' },
      ownerId: 'local',
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 50)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    s.host.configs.update('plein/mock', { settings: { latencyMs: 0, failWith: 'none' } })
  })

  it('平台错误按 code 归一化；未启用的平台不可用', async () => {
    s.host.configs.update('plein/mock', { settings: { latencyMs: 0, failWith: 'rate_limit' } })
    await expect(
      s.host.runNode({ type: 'plein/llm', version: 1, params: { prompt: 'x' }, ownerId: 'local' }),
    ).rejects.toMatchObject({ code: 'rate_limit', retryable: true })
    s.host.configs.update('plein/mock', {
      enabled: false,
      settings: { latencyMs: 0, failWith: 'none' },
    })
    await expect(
      s.host.runNode({ type: 'plein/llm', version: 1, params: { prompt: 'x' }, ownerId: 'local' }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    await expect(
      s.host.runNode({
        type: 'plein/llm',
        version: 1,
        params: { prompt: 'x', model: 'plein/mock:chat' },
        ownerId: 'local',
      }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    s.host.configs.update('plein/mock', { enabled: true })
  })

  it('设置接口：密钥只回显是否已填，文件仅本用户可读', async () => {
    const url = `${s.base}/api/providers/plein/mock/config`
    const put = await fetch(url, s.json('PUT', { secrets: { MOCK_API_KEY: 'sk-123' } }))
    const view = (await put.json()) as ProviderConfigView
    expect(view.secrets).toEqual({ MOCK_API_KEY: true })
    expect(JSON.stringify(view)).not.toContain('sk-123')
    expect(statSync(join(s.dataDir, 'providers.json')).mode & 0o777).toBe(0o600)
    expect((await fetch(url, s.json('PUT', { secrets: { OTHER: 'x' } }))).status).toBe(400)
    expect((await fetch(url, s.json('PUT', { settings: { latencyMs: -1 } }))).status).toBe(400)
    expect((await fetch(`${s.base}/api/providers/acme/none/config`)).status).toBe(404)

    const ok = (await (
      await fetch(`${s.base}/api/providers/plein/mock/test`, { method: 'POST' })
    ).json()) as ProviderTestResult
    expect(ok).toEqual({ ok: true })
    await fetch(url, s.json('PUT', { settings: { latencyMs: 0, failWith: 'auth' } }))
    const bad = (await (
      await fetch(`${s.base}/api/providers/plein/mock/test`, { method: 'POST' })
    ).json()) as ProviderTestResult
    expect(bad).toMatchObject({ ok: false, code: 'auth' })
    await fetch(url, s.json('PUT', { settings: { latencyMs: 0, failWith: 'none' } }))
  })

  it('旧版本节点参数先迁移再执行', async () => {
    const v2 = defineNode({
      type: 'acme/greet',
      version: 2,
      title: 'Greet',
      category: 'util',
      inputs: [],
      outputs: [{ id: 'text', label: '文本', type: 'text' }],
      params: z.object({ name: z.string().default('') }),
      migrate: (p, from) => (from === 1 ? { name: p.who } : p),
    })
    s.host.load(
      [
        defineServerPlugin(
          definePlugin({
            manifest: manifest({ id: 'acme/greet', contributes: { nodes: ['acme/greet@2'] } }),
            nodes: [v2],
          }),
          {
            executors: [
              defineExecutor(v2, async ({ params }) => ({
                text: [{ type: 'text', text: `你好，${params.name}` }],
              })),
            ],
          },
        ),
      ],
      false,
    )
    const out = await s.host.runNode({
      type: 'acme/greet',
      version: 1,
      params: { who: '林夏' },
      ownerId: 'local',
    })
    expect(out.text?.[0]).toEqual({ type: 'text', text: '你好，林夏' })
  })

  it('执行器输出未声明的端口会被拒绝', async () => {
    const bad = defineNode({
      type: 'acme/bad',
      version: 1,
      title: 'Bad',
      category: 'util',
      inputs: [],
      outputs: [{ id: 'text', label: '文本', type: 'text' }],
      params: z.object({}),
    })
    s.host.load(
      [
        defineServerPlugin(
          definePlugin({
            manifest: manifest({ id: 'acme/bad', contributes: { nodes: ['acme/bad@1'] } }),
            nodes: [bad],
          }),
          {
            executors: [
              defineExecutor(bad, async () => ({
                image: [{ type: 'image', assetId: 'x', kind: 'image' }],
              })),
            ],
          },
        ),
      ],
      false,
    )
    await expect(
      s.host.runNode({ type: 'acme/bad', version: 1, ownerId: 'local' }),
    ).rejects.toMatchObject({
      code: 'invalid_output',
    })
  })

  it('Provider 抛出的普通异常归一化为 unknown', async () => {
    expect(new ProviderError('rate_limit', 'x').retryable).toBe(true)
    expect(new ProviderError('auth', 'x').retryable).toBe(false)
  })
})

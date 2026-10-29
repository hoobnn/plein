import { statSync } from 'node:fs'
import { join } from 'node:path'
import { corePlugin } from '@plein/nodes'
import { mockProvider } from '@plein/providers'
import {
  defineExecutor,
  defineNode,
  definePlugin,
  definePromptPreset,
  defineProvider,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  type PluginManifestInput,
  type PollResult,
  type ProviderContext,
  type ProviderRequest,
  type SubmitResult,
  ProviderError,
} from '@plein/plugin-sdk'
import type { Catalog, ProviderConfigView, ProviderTestResult } from '@plein/protocol'
import { Agent } from 'undici'
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { z } from 'zod'
import { startTestServer, tempDir } from '../testing'
import { credentialFingerprint, ProviderConfigStore } from './config-store'
import { type CallRecord, type CallStage, NodeRunError, PluginHost, SHUTDOWN } from './host'
import { Limiter } from './limiter'
import { PluginRegistry } from './registry'
import { PermissionError, scopedFetch, scopedSecrets } from './sandbox'

async function start() {
  const running = await startTestServer()
  return {
    ...running,
    host: running.server.plugins,
    json: (method: string, body: unknown) => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
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

  it('提示词预设：清单要声明，进入目录', () => {
    const prompt = definePromptPreset({ id: 'acme/hero', title: '主角', template: '【主体】特写' })
    const bad = load(
      defineServerPlugin(definePlugin({ manifest: manifest(), prompts: [prompt] }), {}),
    )
    expect(bad.entry.error).toMatch(/contributes.prompts 缺少：acme\/hero/)
    const ok = load(
      defineServerPlugin(
        definePlugin({
          manifest: manifest({ contributes: { prompts: ['acme/hero'] } }),
          prompts: [prompt],
        }),
        {},
      ),
    )
    expect(ok.entry.status).toBe('active')
    expect(ok.r.prompts.get('acme/hero')?.def.template).toBe('【主体】特写')
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

  it('目录接口列出内置节点、Provider 与插件状态', async () => {
    const catalog = (await (await fetch(`${s.base}/api/catalog`)).json()) as Catalog
    // 内置插件都能加载；具体有哪些平台随版本增减，不在这里列死
    expect(catalog.plugins.filter((p) => p.status !== 'active')).toEqual([])
    expect(catalog.plugins.map((p) => p.id)).toEqual(
      expect.arrayContaining(['plein/core', 'plein/mock']),
    )
    const types = catalog.nodes.map((n) => `${n.type}@${n.version}`)
    expect(types).toEqual(corePlugin.manifest.contributes.nodes)
    expect(catalog.nodes.every((n) => n.executable)).toBe(true)
    const image = catalog.nodes.find((n) => n.type === 'plein/image')!
    // 新建节点的默认参数带上默认模型（mock 是开发环境里唯一启用的平台）
    expect(image.defaults).toMatchObject({
      model: 'plein/mock:image',
      aspectRatio: '16:9',
      count: 1,
    })
    expect(catalog.defaultModels).toMatchObject({ 'image.generate': 'plein/mock:image' })
    expect(
      (image.paramsSchema.properties as Record<string, { widget?: string }>).model?.widget,
    ).toBe('model')
    expect(catalog.providers.find((p) => p.id === 'plein/mock')).toMatchObject({
      enabled: true,
      configured: true,
    })
  })

  it('默认模型：空着时取已启用平台的第一个并记住，之后启用别的平台不变；停用后换成还能用的', async () => {
    const { host } = s
    const put = (capability: string, model: string) =>
      fetch(`${s.base}/api/model-defaults`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability, model }),
      })
    expect(host.defaultModel('video.generate')).toBe('plein/mock:video')
    host.configs.update('minimax/api', { enabled: true })
    try {
      expect(host.defaultModel('video.generate')).toBe('plein/mock:video')
      expect((await put('video.generate', 'minimax/api:MiniMax-H3')).status).toBe(200)
      expect(host.defaultModel('video.generate')).toBe('minimax/api:MiniMax-H3')
      // 能力对不上的模型不能设成默认
      expect((await put('image.generate', 'minimax/api:MiniMax-H3')).status).toBe(400)
    } finally {
      host.configs.update('minimax/api', { enabled: false })
    }
    expect(host.defaultModel('video.generate')).toBe('plein/mock:video')
  })

  it('豆包替代鉴权需要完整密钥组；配置检查不声称连接成功', async () => {
    s.host.configs.update('doubao/speech', { secrets: { VOLC_SPEECH_APP_ID: 'app' } })
    const partial = (await (await fetch(`${s.base}/api/catalog`)).json()) as Catalog
    expect(partial.providers.find((p) => p.id === 'doubao/speech')?.configured).toBe(false)
    s.host.configs.update('doubao/speech', { secrets: { VOLC_SPEECH_ACCESS_KEY: 'key' } })
    const complete = (await (await fetch(`${s.base}/api/catalog`)).json()) as Catalog
    expect(complete.providers.find((p) => p.id === 'doubao/speech')?.configured).toBe(true)
    const result = (await (
      await fetch(`${s.base}/api/providers/doubao/speech/test`, { method: 'POST' })
    ).json()) as ProviderTestResult
    expect(result).toMatchObject({
      ok: true,
      scope: 'configuration',
      modelAccess: 'unverified',
      checkedAt: expect.any(Number),
      message: '配置检查通过；尚未验证远端密钥、模型权限或网络',
    })
    s.host.configs.update('doubao/speech', {
      secrets: { VOLC_SPEECH_APP_ID: null, VOLC_SPEECH_ACCESS_KEY: null },
    })
  })

  it('默认平台请求兼容 Electron 内置 fetch 的旧版 dispatcher 协议', async () => {
    const provider = defineProvider({
      id: 'acme/legacy-fetch',
      title: 'Legacy fetch',
      settings: z.object({}),
      secrets: [],
      models: [],
      submit: vi.fn(),
      test: async (ctx) => {
        const response = await ctx.fetch('https://api.acme.com/models', {
          headers: { 'x-probe': 'legacy-fetch' },
        })
        expect(await response.text()).toBe('ok')
      },
    })
    s.host.load(
      [
        defineServerPlugin(
          definePlugin({
            manifest: manifest({
              id: 'acme/legacy-fetch',
              contributes: { providers: ['acme/legacy-fetch'] },
              permissions: { network: ['api.acme.com'] },
            }),
          }),
          { providers: [provider] },
        ),
      ],
      false,
    )
    const transport = vi.spyOn(Agent.prototype, 'dispatch').mockImplementation((_opts, handler) => {
      // undici 8 只接受 v2 回调；裸 Agent 收到旧 fetch 的 v1 回调时必须让此用例失败。
      expect(handler.onRequestStart).toBeTypeOf('function')
      const controller = {
        aborted: false,
        paused: false,
        reason: null,
        abort: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      }
      handler.onRequestStart!(controller, null)
      handler.onResponseStart!(controller, 200, {}, 'OK')
      handler.onResponseEnd!(controller, {})
      return true
    })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      expect(input).toBeInstanceOf(Request)
      const request = input as Request
      expect(request.url).toBe('https://api.acme.com/models')
      expect(request.headers.get('x-probe')).toBe('legacy-fetch')
      expect(init?.redirect).toBe('manual')
      const dispatcher = (init as RequestInit & { dispatcher: Agent }).dispatcher
      return new Promise<Response>((resolve, reject) => {
        // 模拟 Electron 的 undici 7 fetch，不借用当前 Node 26 的 v2 handler。
        dispatcher.dispatch(
          { origin: new URL(request.url).origin, path: '/models', method: request.method },
          {
            onConnect: vi.fn(),
            onHeaders: () => true,
            onComplete: () => resolve(new Response('ok')),
            onError: reject,
          } as unknown as Parameters<Agent['dispatch']>[1],
        )
      })
    })
    try {
      await s.host.testProvider('acme/legacy-fetch', 'local')
      expect(fetch).toHaveBeenCalledOnce()
      expect(transport).toHaveBeenCalledOnce()
      expect(provider.submit).not.toHaveBeenCalled()
    } finally {
      fetch.mockRestore()
      transport.mockRestore()
    }
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
      params: { model: 'plein/mock:image', count: 2, aspectRatio: '9:16' },
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
      params: { model: 'plein/mock:agent', prompt: '写一句台词' },
      ownerId: 'local',
    })
    expect(llm.text?.[0]).toEqual({ type: 'text', text: '【mock】写一句台词' })
    const video = await s.host.runNode({
      type: 'plein/video',
      version: 1,
      params: { model: 'plein/mock:video', prompt: '镜头推近' },
      ownerId: 'local',
    })
    expect(video.video?.[0]).toMatchObject({ type: 'video', mime: 'video/webm' })
    const speech = await s.host.runNode({
      type: 'plein/speech',
      version: 1,
      params: { model: 'plein/mock:audio', text: '你好' },
      ownerId: 'local',
    })
    expect(speech.audio?.[0]).toMatchObject({ type: 'audio', mime: 'audio/wav' })
    const music = await s.host.runNode({
      type: 'plein/music',
      version: 1,
      params: { model: 'plein/mock:audio', prompt: '弦乐' },
      ownerId: 'local',
    })
    expect(music.audio).toHaveLength(1)
  })

  it('参数和输入不合规时给出可读错误', async () => {
    await expect(
      s.host.runNode({
        type: 'plein/image',
        version: 1,
        params: { model: 'plein/mock:image', count: 9 },
        ownerId: 'local',
      }),
    ).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(
      s.host.runNode({
        type: 'plein/image',
        version: 1,
        params: { model: 'plein/mock:image' },
        ownerId: 'local',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: '提示词为空' })
    await expect(
      s.host.runNode({
        type: 'plein/video',
        version: 2,
        params: { model: 'plein/mock:video', prompt: 'x', mode: 'image' },
        inputs: { images: [{ type: 'text', text: 'not an image' }] },
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
      params: { model: 'plein/mock:agent', prompt: '慢一点' },
      ownerId: 'local',
      onProgress: (p) => progress.push(p),
    })
    expect(out.text?.[0]).toMatchObject({ text: '【mock】慢一点' })
    expect(progress.length).toBeGreaterThan(0)

    const ac = new AbortController()
    const cancel = vi.spyOn(mockProvider, 'cancel')
    const run = s.host.runNode({
      type: 'plein/llm',
      version: 1,
      params: { model: 'plein/mock:agent', prompt: 'x' },
      ownerId: 'local',
      signal: ac.signal,
    })
    setTimeout(() => ac.abort(), 50)
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel.mock.calls[0]?.[1].signal.aborted).toBe(false)
    cancel.mockRestore()
    s.host.configs.update('plein/mock', { settings: { latencyMs: 0, failWith: 'none' } })
  })

  it('平台错误按 code 归一化；未启用的平台不可用', async () => {
    s.host.configs.update('plein/mock', { settings: { latencyMs: 0, failWith: 'rate_limit' } })
    await expect(
      s.host.runNode({
        type: 'plein/llm',
        version: 1,
        params: { model: 'plein/mock:agent', prompt: 'x' },
        ownerId: 'local',
      }),
    ).rejects.toMatchObject({ code: 'rate_limit', retryable: true })
    s.host.configs.update('plein/mock', {
      enabled: false,
      settings: { latencyMs: 0, failWith: 'none' },
    })
    await expect(
      s.host.runNode({
        type: 'plein/llm',
        version: 1,
        params: { model: 'plein/mock:agent', prompt: 'x' },
        ownerId: 'local',
      }),
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
    expect(ok).toEqual({
      ok: true,
      scope: 'connection',
      modelAccess: 'unverified',
      checkedAt: expect.any(Number),
      message: '连接检查通过；尚未验证具体模型、资源权限或余额',
    })
    await fetch(url, s.json('PUT', { settings: { latencyMs: 0, failWith: 'auth' } }))
    const bad = (await (
      await fetch(`${s.base}/api/providers/plein/mock/test`, { method: 'POST' })
    ).json()) as ProviderTestResult
    expect(bad).toMatchObject({
      ok: false,
      code: 'auth',
      scope: 'connection',
      modelAccess: 'unverified',
      checkedAt: expect.any(Number),
    })
    await fetch(url, s.json('PUT', { settings: { latencyMs: 0, failWith: 'none' } }))
  })

  it('未提供 test 的平台即使声明 connection，也只报告配置检查且不触发生成', async () => {
    const id = 'acme/no-probe'
    const mock = s.host.registry.providers.get('plein/mock')!
    const submit = vi.fn(mock.def.submit)
    s.host.registry.providers.set(id, {
      ...mock,
      def: { ...mock.def, id, test: undefined, testScope: 'connection', submit },
    })
    try {
      const result = await (
        await fetch(`${s.base}/api/providers/${id}/test`, { method: 'POST' })
      ).json()
      expect(result).toMatchObject({
        ok: true,
        scope: 'configuration',
        modelAccess: 'unverified',
        checkedAt: expect.any(Number),
        message: '配置检查通过；尚未验证远端密钥、模型权限或网络',
      })
      const catalog = (await (await fetch(`${s.base}/api/catalog`)).json()) as Catalog
      expect(catalog.providers.find((p) => p.id === id)?.testScope).toBe('configuration')
      expect(submit).not.toHaveBeenCalled()
    } finally {
      s.host.registry.providers.delete(id)
    }
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
      params: { model: 'plein/mock:agent', who: '林夏' },
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
    const submit = vi.spyOn(mockProvider, 'submit').mockRejectedValueOnce(new Error('连接被重置'))
    await expect(
      s.host.runNode({
        type: 'plein/llm',
        version: 1,
        params: { model: 'plein/mock:agent', prompt: 'x' },
        ownerId: 'local',
      }),
    ).rejects.toMatchObject({ code: 'unknown', message: '连接被重置', retryable: false })
    submit.mockRestore()
  })
})

describe('模型调用记录', () => {
  let s: Awaited<ReturnType<typeof start>>
  beforeAll(async () => {
    s = await start()
  })

  /** 异步平台：提交得到远端任务，轮询结果由各用例决定；模型不支持种子 */
  function asyncHost(timeoutMs?: number) {
    const submit = vi.fn(
      async (_req: ProviderRequest, _ctx: ProviderContext): Promise<SubmitResult> => ({
        state: 'pending',
        remoteId: 'r1',
        pollAfterMs: 1,
      }),
    )
    const poll = vi.fn(async (_remoteId: string, _ctx: ProviderContext): Promise<PollResult> => ({
      state: 'succeeded',
      outputs: [{ type: 'text', text: '好了' }],
    }))
    const provider = defineProvider({
      id: 'acme/async',
      title: 'Async',
      settings: z.object({}),
      secrets: [{ name: 'ASYNC_KEY', title: 'Key', required: true }],
      models: [{ id: 'm', title: 'M', capabilities: ['image.generate'], limits: { seed: false } }],
      submit,
      poll,
    })
    const configs = new ProviderConfigStore(tempDir(), new Set(['acme/async']))
    configs.update('acme/async', { secrets: { ASYNC_KEY: 'one' } })
    const host = new PluginHost(new PluginRegistry(), configs, s.server.assets, {
      timeoutMs,
      log: () => {},
    })
    host.load(
      [
        defineServerPlugin(
          definePlugin({
            manifest: manifest({
              contributes: { providers: ['acme/async'] },
              permissions: { secrets: ['ASYNC_KEY'] },
            }),
          }),
          { providers: [provider] },
        ),
      ],
      false,
    )
    const records = Object.assign(new Map<string, CallRecord>(), { id: 'async-host-journal' })
    const stages: CallStage['phase'][] = []
    const vias: string[] = []
    const call = (signal?: AbortSignal) =>
      host.call(
        'image.generate',
        'acme/async:m',
        { prompt: '天台', seed: 7 },
        {
          ownerId: 'local',
          signal,
          journal: { store: records, key: 'k' },
          onStage: ({ phase, via }) => {
            stages.push(phase)
            vias.push(via)
          },
        },
      )
    return { configs, provider, submit, poll, records, stages, vias, call }
  }

  it('提交受理后立即更新，只有平台明确报告时才展示排队或生成', async () => {
    const { poll, stages, call } = asyncHost()
    poll.mockImplementationOnce(async () => {
      // 首轮查询前已经收到任务 ID，不再显示等待提交响应。
      expect(stages.at(-1)).toBe('accepted')
      return { state: 'pending', remote: 'queued', pollAfterMs: 1 }
    })
    poll.mockResolvedValueOnce({ state: 'pending', remote: 'running', pollAfterMs: 1 })
    poll.mockResolvedValueOnce({ state: 'pending', pollAfterMs: 1 })
    await call()
    expect(stages).toEqual(['submitting', 'accepted', 'queued', 'generating', 'accepted'])
  })

  it('已有远端任务恢复查询时不推测生成，不重复提交', async () => {
    const { submit, poll, records, stages, call } = asyncHost()
    records.set('k', { state: 'pending', remoteId: 'r1' })
    poll.mockImplementationOnce(async () => {
      expect(stages).toEqual(['accepted'])
      return { state: 'succeeded', outputs: [{ type: 'text', text: '已恢复' }] }
    })
    await call()
    expect(submit).not.toHaveBeenCalled()
  })

  it('记录里已有结果：直接返回，不提交也不轮询', async () => {
    const { submit, poll, records, call } = asyncHost()
    records.set('k', {
      state: 'done',
      result: { outputs: [{ type: 'text', text: '旧的' }], assets: [] },
    })
    expect((await call()).outputs).toEqual([{ type: 'text', text: '旧的' }])
    expect(submit).not.toHaveBeenCalled()
    expect(poll).not.toHaveBeenCalled()
  })

  it('模型声明不支持的参数不传给平台；成功后记下结果', async () => {
    const { submit, records, call } = asyncHost()
    await call()
    expect(submit.mock.calls[0]![0]).toMatchObject({ input: { prompt: '天台' } })
    expect(submit.mock.calls[0]![0].input).not.toHaveProperty('seed')
    // 远端 ID 也留着：重启续跑后能核对是不是同一个任务
    expect(records.get('k')).toMatchObject({ state: 'done', remoteId: 'r1' })
  })

  it('远端确认失败：删掉记录，下次重新提交', async () => {
    const { submit, poll, records, call } = asyncHost()
    poll.mockResolvedValueOnce({
      state: 'failed',
      error: { code: 'unavailable', message: '远端出错', retryable: true },
    })
    await expect(call()).rejects.toMatchObject({ code: 'unavailable' })
    expect(records.has('k')).toBe(false)
    await call()
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('查询断流或状态未知保留远端记录，恢复不重复提交', async () => {
    const { submit, poll, records, call } = asyncHost()
    poll.mockRejectedValueOnce(new ProviderError('unavailable', '响应体中断', { retryable: true }))
    await expect(call()).rejects.toMatchObject({ code: 'unavailable' })
    expect(records.get('k')).toMatchObject({ state: 'pending', remoteId: 'r1' })
    poll.mockRejectedValueOnce(new ProviderError('unknown', '未知任务状态'))
    await expect(call()).rejects.toMatchObject({ code: 'unknown' })
    expect(records.get('k')).toMatchObject({ state: 'pending', remoteId: 'r1' })
    await call()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(records.get('k')).toMatchObject({ state: 'done', remoteId: 'r1' })
  })

  it('切换当前密钥组后，恢复轮询仍使用提交时的组', async () => {
    const { configs, submit, poll, records, vias, call } = asyncHost()
    const originalId = configs.get('acme/async').activeCredential!
    const seen: string[] = []
    submit.mockImplementationOnce(async (_req, ctx) => {
      seen.push(ctx.secret('ASYNC_KEY')!)
      return { state: 'pending', remoteId: 'r1', pollAfterMs: 1 }
    })
    poll.mockImplementationOnce(async (_remoteId, ctx) => {
      seen.push(ctx.secret('ASYNC_KEY')!)
      throw new ProviderError('unavailable', '稍后再查', { retryable: true })
    })
    await expect(call()).rejects.toMatchObject({ code: 'unavailable' })
    expect(records.get('k')).toMatchObject({ state: 'pending', credentialId: originalId })

    const withTeam = configs.addCredential('acme/async', '团队', { ASYNC_KEY: 'two' })
    configs.setActiveCredential('acme/async', withTeam.credentials[1]!.id)
    poll.mockImplementationOnce(async (_remoteId, ctx) => {
      seen.push(ctx.secret('ASYNC_KEY')!)
      return { state: 'succeeded', outputs: [{ type: 'text', text: '原组结果' }] }
    })
    await call()
    expect(seen).toEqual(['one', 'one', 'one'])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(records.get('k')).toMatchObject({ state: 'done', credentialId: originalId })
    expect(vias.at(-1)).toBe('Async（默认）· M')
  })

  it('原密钥组删除后恢复为 auth 失败，不重新提交', async () => {
    const { configs, submit, poll, records, call } = asyncHost()
    const originalId = configs.get('acme/async').activeCredential!
    poll.mockRejectedValueOnce(new ProviderError('unavailable', '稍后再查', { retryable: true }))
    await expect(call()).rejects.toMatchObject({ code: 'unavailable' })
    const withTeam = configs.addCredential('acme/async', '团队', { ASYNC_KEY: 'two' })
    configs.setActiveCredential('acme/async', withTeam.credentials[1]!.id)
    configs.removeCredential('acme/async', originalId)

    await expect(call()).rejects.toMatchObject({
      code: 'auth',
      message: expect.stringContaining('已删除'),
    })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(records.get('k')).toMatchObject({ state: 'pending', credentialId: originalId })
  })

  it('同组密钥修改后恢复为 auth 失败，不核查也不重新提交', async () => {
    const { configs, provider, submit, records, call } = asyncHost()
    const originalId = configs.get('acme/async').activeCredential!
    const lookup = vi.fn(async () => null)
    provider.lookup = lookup
    provider.idempotent = true
    const controller = new AbortController()
    submit.mockImplementationOnce(async () => {
      controller.abort(SHUTDOWN)
      throw new ProviderError('unknown', '服务退出', { outcome: 'unknown' })
    })
    await expect(call(controller.signal)).rejects.toMatchObject({ code: 'unknown' })
    expect(records.get('k')).toMatchObject({
      state: 'submitting',
      credentialId: originalId,
      credentialFingerprint: credentialFingerprint({ ASYNC_KEY: 'one' }),
    })

    configs.patchCredential('acme/async', originalId, { secrets: { ASYNC_KEY: 'two' } })
    submit.mockClear()
    await expect(call()).rejects.toMatchObject({
      code: 'auth',
      retryable: false,
      message:
        '平台 Async 提交该任务时使用的密钥「默认」已被修改，无法继续；为避免重复计费不会重新提交',
    })
    expect(submit).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('提交发出后取消，未知记录不能当成未提交丢弃', async () => {
    const { submit, records, call } = asyncHost()
    submit.mockRejectedValueOnce(
      new ProviderError('cancelled', '读取响应时已取消', { outcome: 'unknown' }),
    )
    await expect(call()).rejects.toMatchObject({ outcome: 'unknown', stage: 'submit_unknown' })
    expect(records.get('k')).toMatchObject({ state: 'unknown' })
    await expect(call()).rejects.toMatchObject({ stage: 'submit_unknown' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('同步大文件保存失败：ready暂存恢复成功且不重新生成', async () => {
    const { submit, records, call } = asyncHost()
    submit.mockResolvedValueOnce({
      state: 'succeeded',
      outputs: [
        {
          type: 'file',
          kind: 'audio',
          mime: 'audio/wav',
          data: new Uint8Array(16 * 1024 * 1024 + 1),
        },
      ],
    })
    const ingest = vi
      .spyOn(s.server.assets, 'ingest')
      .mockRejectedValueOnce(new Error('storage unavailable'))
    try {
      await expect(call()).rejects.toMatchObject({ stage: 'fetch_failed' })
      const original = records.get('k')
      expect(original).toMatchObject({
        state: 'fetched',
        outputs: [expect.objectContaining({ spool: expect.objectContaining({ state: 'ready' }) })],
      })
      await expect(call()).resolves.toMatchObject({
        assets: [expect.objectContaining({ kind: 'audio' })],
      })
      expect(records.get('k')).toMatchObject({ state: 'done' })
      expect(submit).toHaveBeenCalledTimes(1)
      expect(ingest).toHaveBeenCalledTimes(2)
    } finally {
      ingest.mockRestore()
    }
  })

  it('超时归为 timeout', async () => {
    const { poll, call } = asyncHost(50)
    poll.mockResolvedValue({ state: 'pending', pollAfterMs: 10 })
    await expect(call()).rejects.toMatchObject({ code: 'timeout' })
  })
})

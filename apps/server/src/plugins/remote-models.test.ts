/**
 * 远端模型列表的合并规则、缓存与宿主集成。
 * 传输层契约在 packages/providers 里测，这里关心合并、缓存上下文、代次保护与提交链路。
 */
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Catalog } from '@plein/protocol'
import {
  definePlugin,
  defineProvider,
  PLUGIN_API_VERSION,
  type CapabilityInput,
  type ProviderRequest,
  type RemoteModel,
  type ServerPluginDefinition,
} from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { bootServer, request, until } from '../testing'
import { applyRemoteModels, inferCapability, RemoteModelCache } from './remote-models'

const builtin = [
  { id: 'known', title: '已知对话', capabilities: ['text.chat' as const] },
  { id: 'known-image', title: '已知图片', capabilities: ['image.generate' as const] },
  {
    id: 'custom-image',
    title: '自定义图片模型（设置中填写）',
    capabilities: ['image.generate' as const],
  },
]

describe('合并规则', () => {
  const scope = ['text.chat' as const]

  it('覆盖范围内才标 available / unlisted；占位槽与范围外能力不标', () => {
    const merged = applyRemoteModels(builtin, [{ id: 'known' }], scope)
    expect(merged.find((m) => m.id === 'known')?.remote).toBe('available')
    // 图片能力不在覆盖范围（如 MiniMax 列表只含对话模型），不能标成未收录
    expect(merged.find((m) => m.id === 'known-image')?.remote).toBeUndefined()
    expect(merged.find((m) => m.id === 'custom-image')?.remote).toBeUndefined()
  })

  it('目录没收录的新模型以通用能力追加，标 remote-only', () => {
    const merged = applyRemoteModels(
      builtin,
      [{ id: 'doubao-seedance-9-9', name: 'Seedance 9.9' }, { id: 'plain-model-x' }, { id: 'totally-new', kind: 'image' }],
      scope,
    )
    const extra = merged.filter((m) => m.remoteOnly)
    expect(extra.map((m) => [m.id, m.capabilities[0]])).toEqual([
      ['doubao-seedance-9-9', 'video.generate'],
      ['plain-model-x', 'text.chat'],
      ['totally-new', 'image.generate'],
    ])
    expect(extra.every((m) => m.title && m.description?.includes('通用默认'))).toBe(true)
  })

  it('没拉取过时不加任何标记，也不追加新模型', () => {
    expect(applyRemoteModels(builtin, undefined, scope)).toEqual(builtin)
  })

  it('推断：前缀归类，kind 提示优先，认不出归为对话', () => {
    expect(inferCapability({ id: 'qwen3.9-max' })).toBe('text.chat')
    expect(inferCapability({ id: 'seedream-x', kind: 'video' })).toBe('video.generate')
    expect(inferCapability({ id: 'speech-9' })).toBe('audio.speech')
    expect(inferCapability({ id: 'music-9' })).toBe('audio.music')
  })
})

describe('缓存', () => {
  it('TTL 内 fresh、过期 stale、密钥或设置变化后 idle', () => {
    let now = 1_000_000
    const cache = new RemoteModelCache('', 24 * 60 * 60 * 1000, () => now)
    cache.record('p', 'fp-a', '{"region":"cn"}', [{ id: 'm1' }])
    expect(cache.status('p', 'fp-a', '{"region":"cn"}')).toMatchObject({
      status: 'fresh',
      fetchedAt: 1_000_000,
    })
    now += 24 * 60 * 60 * 1000 - 1
    expect(cache.status('p', 'fp-a', '{"region":"cn"}').status).toBe('fresh')
    now += 1
    expect(cache.status('p', 'fp-a', '{"region":"cn"}').status).toBe('stale')
    // 换密钥：旧列表不可见
    expect(cache.status('p', 'fp-b', '{"region":"cn"}')).toEqual({ fetchedAt: null, status: 'idle' })
    expect(cache.models('p', 'fp-b', '{"region":"cn"}')).toBeUndefined()
    // 换设置（如地域）：同样不可见
    expect(cache.models('p', 'fp-a', '{"region":"global"}')).toBeUndefined()
  })

  it('失败的拉取保留上一次成功列表，错误保留到新鲜期内', () => {
    let now = 1_000_000
    const cache = new RemoteModelCache('', 24 * 60 * 60 * 1000, () => now)
    cache.record('p', 'fp-a', '', [{ id: 'm1' }])
    cache.record('p', 'fp-a', '', [], '网络失败')
    expect(cache.models('p', 'fp-a', '')).toEqual([{ id: 'm1' }])
    expect(cache.status('p', 'fp-a', '')).toMatchObject({ status: 'fresh', error: '网络失败' })
    // 换了上下文再失败：没有可信列表，不返回数据（避免全部标成 unlisted），错误仍显示
    cache.record('p', 'fp-b', '', [], '缺少密钥')
    expect(cache.models('p', 'fp-b', '')).toBeUndefined()
    expect(cache.status('p', 'fp-b', '')).toMatchObject({ status: 'fresh', error: '缺少密钥' })
  })

  it('空目录只留内存；有目录时原子落盘（0600）并可在重载后读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plein-remote-'))
    const first = new RemoteModelCache(dir)
    first.record('p', 'fp-a', '', [{ id: 'm1' }])
    const file = join(dir, 'remote-models.json')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(new RemoteModelCache(dir).models('p', 'fp-a', '')).toEqual([{ id: 'm1' }])
    first.invalidate('p')
    expect(JSON.parse(readFileSync(file, 'utf8'))['p']).toBeUndefined()
  })

  it('损坏的缓存文件按空缓存处理，不影响重新写入', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plein-remote-'))
    const file = join(dir, 'remote-models.json')
    writeFileSync(file, '{ 不是 JSON', { mode: 0o600 })
    const cache = new RemoteModelCache(dir)
    expect(cache.status('p', 'fp-a', '')).toEqual({ fetchedAt: null, status: 'idle' })
    cache.record('p', 'fp-a', '', [{ id: 'm1' }])
    expect(new RemoteModelCache(dir).models('p', 'fp-a', '')).toEqual([{ id: 'm1' }])
  })
})

/** 带远端列表的假平台：pull 可指定成功或失败；submit 记录收到的请求 */
function remotePlugin(
  pull: () => Promise<RemoteModel[]>,
  over: { scope?: ('text.chat' | 'image.generate')[]; settingsKeys?: string[] } = {},
): ServerPluginDefinition {
  const provider = defineProvider({
    id: 'acme/remote',
    title: '远端列表',
    settings: z.object({ region: z.string().default('cn') }),
    secrets: [{ name: 'KEY', title: 'Key', required: true }],
    models: builtin,
    remoteModelsScope: over.scope ?? ['text.chat'],
    remoteModelsSettings: over.settingsKeys ?? ['region'],
    listRemoteModels: pull,
    submit: async (req: ProviderRequest) => ({
      state: 'succeeded' as const,
      outputs: [{ type: 'text' as const, text: `${req.model}:${req.remoteOnly ? 1 : 0}` }],
    }),
  })
  return {
    plugin: definePlugin({
      manifest: {
        id: 'acme/test',
        version: '0.1.0',
        name: '远端列表测试',
        engines: { plein: `^${PLUGIN_API_VERSION}` },
        contributes: { providers: ['acme/remote'] },
        permissions: { network: [], secrets: ['KEY'] },
      },
    }),
    providers: [provider],
    executors: [],
    capabilities: [],
  }
}

async function booted(
  pull: () => Promise<RemoteModel[]>,
  over: { scope?: ('text.chat' | 'image.generate')[]; settingsKeys?: string[] } = {},
) {
  const { server, dataDir } = await bootServer()
  void dataDir
  server.plugins.load([remotePlugin(pull, over)], true)
  server.plugins.configs.addCredential('acme/remote', '默认', { KEY: 'k' })
  server.plugins.configs.update('acme/remote', { enabled: true })
  const catalog = async (): Promise<Catalog> =>
    (await (await request(server, '/api/catalog')).json()) as Catalog
  return { server, dataDir, host: server.plugins, catalog }
}

describe('宿主集成', () => {
  it('没拉取过：状态 idle，目录条目不带远端标记', async () => {
    const { catalog } = await booted(async () => [])
    const info = (await catalog()).providers.find((p) => p.id === 'acme/remote')
    expect(info?.remoteModels).toEqual({ fetchedAt: null, status: 'idle' })
    expect(info?.models.every((m) => m.remote === undefined)).toBe(true)
  })

  it('刷新成功：状态 fresh，目录合并出 available 与 remote-only', async () => {
    const { server, catalog } = await booted(async () => [{ id: 'known' }, { id: 'brand-new' }])
    const res = await request(
      server,
      '/api/providers/acme/remote/remote-models/refresh',
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const status = (await res.json()) as { status: string; fetchedAt: number }
    expect(status.status).toBe('fresh')
    const info = (await catalog()).providers.find((p) => p.id === 'acme/remote')
    expect(info?.remoteModels?.status).toBe('fresh')
    expect(info?.models.find((m) => m.id === 'known')?.remote).toBe('available')
    expect(info?.models.find((m) => m.id === 'brand-new')?.remoteOnly).toBe(true)
  })

  it('刷新失败：目录不受影响，错误记入状态', async () => {
    const { server, catalog } = await booted(async () => {
      throw new Error('平台 502')
    })
    const res = await request(
      server,
      '/api/providers/acme/remote/remote-models/refresh',
      { method: 'POST' },
    )
    const status = (await res.json()) as { status: string; error?: string }
    expect(status.error).toContain('平台 502')
    const info = (await catalog()).providers.find((p) => p.id === 'acme/remote')
    expect(info?.models.every((m) => m.remoteOnly !== true)).toBe(true)
    expect(info?.models.every((m) => m.remote === undefined)).toBe(true)
  })

  it('未实现拉取的平台：刷新返回 not_supported，目录没有远端状态', async () => {
    const { server, catalog } = await booted(async () => [])
    const res = await request(
      server,
      '/api/providers/plein/mock/remote-models/refresh',
      { method: 'POST' },
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('not_supported')
    expect((await catalog()).providers.find((p) => p.id === 'plein/mock')?.remoteModels).toBeUndefined()
  })

  it('设置变化后旧列表失效：状态回到 idle，重新刷新按新上下文写入', async () => {
    let region = 'cn'
    const { host } = await booted(async () => [{ id: `m-${region}` }])
    await host.refreshRemoteModels('acme/remote', 'local')
    expect(host.remoteModelsStatus('acme/remote')?.status).toBe('fresh')
    host.configs.update('acme/remote', { settings: { region: 'global' } })
    region = 'global'
    expect(host.remoteModelsStatus('acme/remote')).toEqual({ fetchedAt: null, status: 'idle' })
    expect(host.mergedModels('acme/remote', builtin).every((m) => m.remoteOnly !== true)).toBe(true)
    await host.refreshRemoteModels('acme/remote', 'local')
    expect(host.remoteModelsStatus('acme/remote')?.status).toBe('fresh')
    expect(host.mergedModels('acme/remote', builtin).some((m) => m.id === 'm-global')).toBe(true)
    expect(host.mergedModels('acme/remote', builtin).some((m) => m.id === 'm-cn')).toBe(false)
  })

  it('并发刷新按代次保护：慢的旧响应不覆盖新结果', async () => {
    let release!: () => void
    const gate = new Promise<void>((ok) => (release = ok))
    let calls = 0
    const { host } = await booted(async () => {
      calls += 1
      if (calls === 1) await gate
      return [{ id: `m-${calls}` }]
    })
    const first = host.refreshRemoteModels('acme/remote', 'local')
    await until(() => calls === 1)
    const second = host.refreshRemoteModels('acme/remote', 'local')
    await second
    release()
    await first
    // 先发出、后完成的旧请求（m-1）不能覆盖新请求（m-2）的结果
    expect(host.mergedModels('acme/remote', builtin).some((m) => m.id === 'm-2')).toBe(true)
    expect(host.mergedModels('acme/remote', builtin).some((m) => m.id === 'm-1')).toBe(false)
  })

  it('覆盖范围为空的平台不参与合并，列表只作候选', async () => {
    let list: RemoteModel[] = [{ id: 'gpt-x', name: 'GPT X' }]
    const { host, catalog } = await booted(async () => list, { scope: [] })
    expect(host.remoteModelsStatus('acme/remote')).toBeUndefined()
    await host.refreshRemoteModels('acme/remote', 'local')
    const info = (await catalog()).providers.find((p) => p.id === 'acme/remote')
    expect(info?.remoteModels).toBeUndefined()
    expect(info?.models.every((m) => m.remoteOnly !== true && m.remote === undefined)).toBe(true)
    expect(host.remoteModelCandidates('acme/remote')).toEqual([{ id: 'gpt-x', name: 'GPT X' }])
    list = [{ id: 'gpt-y' }]
    await host.refreshRemoteModels('acme/remote', 'local')
    expect(host.remoteModelCandidates('acme/remote')).toEqual([{ id: 'gpt-y' }])
  })

  describe('remote-only 提交', () => {
    it('覆盖范围内的对话模型可提交，宿主带上 remoteOnly', async () => {
      const { host } = await booted(async () => [{ id: 'brand-new' }])
      await host.refreshRemoteModels('acme/remote', 'local')
      const result = await host.call(
        'text.chat',
        'acme/remote:brand-new',
        { messages: [{ role: 'user', content: '嗨' }] } as CapabilityInput<'text.chat'>,
        { ownerId: 'local' },
      )
      expect(result.outputs[0]).toEqual({ type: 'text', text: 'brand-new:1' })
    })

    it('覆盖范围外的能力与未知模型都在宿主侧拒绝', async () => {
      const { host } = await booted(async () => [{ id: 'brand-new-image', kind: 'image' }])
      await host.refreshRemoteModels('acme/remote', 'local')
      await expect(
        host.call(
          'image.generate',
          'acme/remote:brand-new-image',
          { prompt: 'x' } as CapabilityInput<'image.generate'>,
          { ownerId: 'local' },
        ),
      ).rejects.toThrow(/只在设置的模型列表里展示/)
      await expect(
        host.call(
          'text.chat',
          'acme/remote:nope',
          { messages: [{ role: 'user', content: '嗨' }] } as CapabilityInput<'text.chat'>,
          { ownerId: 'local' },
        ),
      ).rejects.toThrow(/没有模型/)
    })
  })
})

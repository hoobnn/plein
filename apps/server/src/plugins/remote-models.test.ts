/**
 * 远端模型列表的合并规则、缓存与宿主集成。
 * 传输层契约在 packages/providers 里测，这里只关心合并、TTL 与失败回退。
 */
import { join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Catalog } from '@plein/protocol'
import {
  definePlugin,
  defineProvider,
  PLUGIN_API_VERSION,
  type RemoteModel,
} from '@plein/plugin-sdk'
import type { ServerPluginDefinition } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { bootServer, request } from '../testing'
import { applyRemoteModels, inferCapability, RemoteModelCache } from './remote-models'

const builtin = [
  { id: 'known', title: '已知模型', capabilities: ['text.chat' as const] },
  {
    id: 'custom-image',
    title: '自定义图片模型（设置中填写）',
    capabilities: ['image.generate' as const],
  },
]

describe('合并规则', () => {
  it('内置条目按远端列表标 available / unlisted；占位槽不参与比对', () => {
    const merged = applyRemoteModels(builtin, [{ id: 'known' }])
    expect(merged.find((m) => m.id === 'known')?.remote).toBe('available')
    expect(merged.find((m) => m.id === 'custom-image')?.remote).toBeUndefined()
  })

  it('目录没收录的新模型以通用能力追加，标 remote-only', () => {
    const merged = applyRemoteModels(builtin, [
      { id: 'doubao-seedance-9-9', name: 'Seedance 9.9' },
      { id: 'plain-model-x' },
      { id: 'totally-new', kind: 'image' },
    ])
    const extra = merged.filter((m) => m.remoteOnly)
    expect(extra.map((m) => [m.id, m.capabilities[0]])).toEqual([
      ['doubao-seedance-9-9', 'video.generate'],
      ['plain-model-x', 'text.chat'],
      ['totally-new', 'image.generate'],
    ])
    expect(extra.every((m) => m.title && m.description?.includes('通用默认'))).toBe(true)
  })

  it('没拉取过时不加任何标记，也不追加新模型', () => {
    expect(applyRemoteModels(builtin, undefined)).toEqual(builtin)
  })

  it('推断：前缀归类，kind 提示优先，认不出归为对话', () => {
    expect(inferCapability({ id: 'qwen3.9-max' })).toBe('text.chat')
    expect(inferCapability({ id: 'seedream-x', kind: 'video' })).toBe('video.generate')
    expect(inferCapability({ id: 'speech-9' })).toBe('audio.speech')
    expect(inferCapability({ id: 'music-9' })).toBe('audio.music')
  })
})

describe('缓存', () => {
  it('TTL 内 fresh、过期 stale、密钥更换后 idle', () => {
    let now = 1_000_000
    const cache = new RemoteModelCache('', 24 * 60 * 60 * 1000, () => now)
    cache.record('p', 'fp-a', [{ id: 'm1' }])
    expect(cache.status('p', 'fp-a')).toMatchObject({ status: 'fresh', fetchedAt: 1_000_000 })
    now += 24 * 60 * 60 * 1000 - 1
    expect(cache.status('p', 'fp-a').status).toBe('fresh')
    now += 1
    expect(cache.status('p', 'fp-a').status).toBe('stale')
    expect(cache.status('p', 'fp-b')).toEqual({ fetchedAt: null, status: 'idle' })
    expect(cache.models('p', 'fp-b')).toBeUndefined()
  })

  it('失败的拉取保留上一次成功列表，错误保留到新鲜期内', () => {
    let now = 1_000_000
    const cache = new RemoteModelCache('', 24 * 60 * 60 * 1000, () => now)
    cache.record('p', 'fp-a', [{ id: 'm1' }])
    cache.record('p', 'fp-a', [], '网络失败')
    expect(cache.models('p', 'fp-a')).toEqual([{ id: 'm1' }])
    expect(cache.status('p', 'fp-a')).toMatchObject({ status: 'fresh', error: '网络失败' })
    // 换了密钥再失败：没有可信列表，不返回数据（避免全部标成 unlisted），错误仍显示
    cache.record('p', 'fp-b', [], '缺少密钥')
    expect(cache.models('p', 'fp-b')).toBeUndefined()
    expect(cache.status('p', 'fp-b')).toMatchObject({ status: 'fresh', error: '缺少密钥' })
  })

  it('空目录只留内存；有目录时落盘并可在重载后读回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plein-remote-'))
    const first = new RemoteModelCache(dir)
    first.record('p', 'fp-a', [{ id: 'm1' }])
    expect(existsSync(join(dir, 'remote-models.json'))).toBe(true)
    expect(new RemoteModelCache(dir).models('p', 'fp-a')).toEqual([{ id: 'm1' }])
    first.invalidate('p')
    expect(JSON.parse(readFileSync(join(dir, 'remote-models.json'), 'utf8'))['p']).toBeUndefined()
  })
})

/** 带远端列表的假平台：pull 可指定成功或失败 */
function remotePlugin(pull: () => Promise<RemoteModel[]>): ServerPluginDefinition {
  const provider = defineProvider({
    id: 'acme/remote',
    title: '远端列表',
    settings: z.object({}),
    secrets: [{ name: 'KEY', title: 'Key', required: true }],
    models: builtin,
    listRemoteModels: pull,
    submit: async () => ({ state: 'succeeded', outputs: [{ type: 'text', text: 'x' }] }),
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

async function booted(pull: () => Promise<RemoteModel[]>) {
  const { server, dataDir } = await bootServer()
  // 缓存落盘路径由 app.ts 注入；这里只验证内存行为，沿用构造时的默认（仅内存）
  void dataDir
  server.plugins.load([remotePlugin(pull)], true)
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
    const res = await request(server, '/api/providers/acme/remote/remote-models/refresh', {
      method: 'POST',
    })
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
    const res = await request(server, '/api/providers/acme/remote/remote-models/refresh', {
      method: 'POST',
    })
    const status = (await res.json()) as { status: string; error?: string }
    expect(status.error).toContain('平台 502')
    const info = (await catalog()).providers.find((p) => p.id === 'acme/remote')
    expect(info?.models.every((m) => m.remoteOnly !== true)).toBe(true)
    expect(info?.models.every((m) => m.remote === undefined)).toBe(true)
  })

  it('未实现拉取的平台：刷新返回 not_supported，目录没有远端状态', async () => {
    const { server, catalog } = await booted(async () => [])
    const res = await request(server, '/api/providers/plein/mock/remote-models/refresh', {
      method: 'POST',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('not_supported')
    expect(
      (await catalog()).providers.find((p) => p.id === 'plein/mock')?.remoteModels,
    ).toBeUndefined()
  })
})

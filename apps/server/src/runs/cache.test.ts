import { connect, createElement, setParams } from '@plein/doc'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings } from '../testing'
import { cacheParams } from './runs'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('缓存键参数', () => {
  it('只算所选模型的专属参数，空的和留空的分辨率不算', () => {
    const base = { model: 'a:m', prompt: 'x', resolution: '', options: {} }
    expect(cacheParams(base)).toEqual({ model: 'a:m', prompt: 'x' })
    expect(
      cacheParams({
        ...base,
        resolution: '1080p',
        options: { 'a:m': { watermark: true }, 'b:n': { x: 1 } },
      }),
    ).toEqual({ model: 'a:m', prompt: 'x', resolution: '1080p', options: { watermark: true } })
    // 别的模型的设置改了不影响
    expect(cacheParams({ ...base, options: { 'b:n': { x: 2 } } })).toEqual(cacheParams(base))
    expect(cacheParams(base, ['prompt'])).toEqual({ model: 'a:m' })
    // 语速 1 倍是后加参数的中性值
    expect(cacheParams({ ...base, speed: 1 })).toEqual(cacheParams(base))
    expect(cacheParams({ ...base, speed: 1.2 })).toMatchObject({ speed: 1.2 })
    // 角色图片归档目标只决定结果存到角色库的哪个槽位，不影响生成内容
    expect(
      cacheParams({
        ...base,
        characterAssetTarget: { libraryId: 'role-1', slot: 'full_body' },
      }),
    ).toEqual(cacheParams(base))
  })
})

describe('缓存键与实际生成内容一致', () => {
  it('只改角色图片归档目标不重跑：归档槽位不影响生成内容', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const n = addNode(doc, 'plein/image', {
      params: { model: 'plein/mock:image', prompt: '天台' },
    })
    const before = await server.runs.preview(id, n, 'local')
    expect(before.status).toBe('ready')
    setParams(doc, n, { characterAssetTarget: { libraryId: 'role-1', slot: 'full_body' } })
    const after = await server.runs.preview(id, n, 'local')
    expect(after.inputHash).toBe(before.inputHash)
  })

  it('MiniMax H3 图生视频改画幅不重跑：平台实收画幅被自动控制项定下', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const first = createElement(doc, {
      kind: 'image',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 400,
      w: 100,
      h: 100,
    })
    const n = addNode(doc, 'plein/video', {
      params: {
        model: 'minimax/api:MiniMax-H3',
        mode: 'image',
        prompt: '缓慢推近',
        aspectRatio: '16:9',
      },
    })
    connect(doc, [first, 'image'], [n, 'images'])
    const before = await server.runs.preview(id, n, 'local')
    expect(before.status).toBe('ready')
    setParams(doc, n, { aspectRatio: '9:16' })
    const after = await server.runs.preview(id, n, 'local')
    expect(after.inputHash).toBe(before.inputHash)
  })

  it('升级前的缓存键仍被认作有效：升级后旧结果不整批过期', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const n = addNode(doc, 'plein/image', {
      params: { model: 'plein/mock:image', prompt: '天台' },
    })
    setParams(doc, n, { characterAssetTarget: { libraryId: 'role-1', slot: 'full_body' } })
    const runId = server.runs.start(id, n, 'local')
    expect(await server.runs.wait(runId)).toBe('succeeded')
    const runs = server.runs as unknown as {
      prepare(...a: unknown[]): Promise<unknown>
      resolveModel(ref: string): { ref: string; version?: string; plugin?: string }
      hashKey(...a: unknown[]): string
    }
    const el = doc.get(n)!
    const prepared = await runs.prepare(doc, el, 'local', new AbortController().signal)
    const m = runs.resolveModel('plein/mock:image')
    // 升级前的算法：角色图片归档目标还计入键
    const old =
      'v2:' +
      runs.hashKey(el, prepared, [], new Set(['requiredRefs', 'referenceImagePicks', 'usedRefs']), {
        model: { ref: m.ref, version: m.version, plugin: m.plugin },
      })
    server.runs.store.update(runId, { cache_key: old })
    const stale = await server.runs.staleNodes(id, 'local')
    expect(stale.stale).not.toContain(n)
  })
})

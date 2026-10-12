import type { Engine } from '@plein/canvas-core'
import { createDoc } from '@plein/doc'
import { corePlugin, libraryKind, slotImages } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Asset, Catalog, LibraryItem } from '@plein/protocol'
import { describe, expect, it, vi } from 'vitest'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const V = 'c'.repeat(64)

vi.mock('../api/client', () => ({
  api: {
    assetMeta: async (id: string): Promise<Asset> => {
      if (id === 'f'.repeat(64)) throw new Error('not found')
      const video = id === V
      return {
        id,
        kind: video ? 'video' : 'image',
        mime: video ? 'video/mp4' : 'image/png',
        name: id.slice(0, 4),
        size: 1,
        width: 400,
        height: 600,
        variants: [],
        createdAt: 0,
      }
    },
  },
}))

const { cardSnapshot, placeLibraryItem, placeInputOf, saveCardToLibrary } = await import(
  './library'
)

const nodes = corePlugin.nodes.map((n) => ({ ...describeNode(n, 'plein/core'), executable: true }))
const catalog = { nodes, providers: [] } as unknown as Catalog

const setup = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  let selected: string[] = []
  const engine = {
    doc,
    camera: { viewRect: { x: 0, y: 0, w: 1000, h: 800 }, centerOn: () => {} },
    scene: { rect: () => null },
    selection: { set: (ids: string[]) => (selected = ids) },
    setTool: () => {},
  } as unknown as Engine
  return { doc, engine, selected: () => selected }
}

const item = (patch: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 'lib_1',
  kind: 'character',
  name: '林夏',
  projectId: null,
  description: '二十岁，黑长直',
  tags: { gender: '女' },
  voice: { provider: 'plein/doubao-speech', voiceId: 'S_1' },
  images: [
    { slot: 'extra', assetId: B },
    { slot: 'main', assetId: A },
  ],
  video: null,
  models: [],
  favorite: false,
  usedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})

describe('资产库 ↔ 画布', () => {
  it('角色展开成卡片 + 连好的参考图，主图在前，再存回去内容一致', async () => {
    const { doc, engine, selected } = setup()
    const r = await placeLibraryItem(engine, catalog, placeInputOf(item())!)
    expect(r.id).toBeTruthy()
    const card = doc.get(r.id!)!
    expect(card).toMatchObject({ nodeType: 'plein/character', name: '林夏' })
    expect(card.params).toMatchObject({
      description: '二十岁，黑长直',
      voice: { provider: 'plein/doubao-speech', voiceId: 'S_1' },
      libraryId: 'lib_1',
    })
    expect(selected()).toEqual([r.id])
    const edges = [...doc.edges()].filter((e) => e.to[0] === r.id && e.to[1] === 'references')
    expect(edges).toHaveLength(2)
    // 素材在卡片左侧一列，主图在上
    const refs = edges.map((e) => doc.get(e.from[0])!).sort((a, b) => a.y - b.y)
    expect(refs.map((el) => el.assetId)).toEqual([A, B])
    expect(refs.every((el) => el.x + el.w < card.x)).toBe(true)

    const snap = cardSnapshot(engine, card, 'pj_1')!
    expect(snap.body).toMatchObject({
      kind: 'character',
      name: '林夏',
      projectId: 'pj_1',
      description: '二十岁，黑长直',
      voice: { provider: 'plein/doubao-speech', voiceId: 'S_1' },
      images: [
        { slot: 'main', assetId: A },
        { slot: 'extra', assetId: B },
      ],
    })
  })

  it('同一条资产已在画布上时只选中，不重复铺；找不到的素材跳过并说明', async () => {
    const { doc, engine } = setup()
    const first = await placeLibraryItem(engine, catalog, placeInputOf(item())!)
    const count = [...doc.elements()].length
    const again = await placeLibraryItem(engine, catalog, placeInputOf(item())!)
    expect(again.id).toBe(first.id)
    expect([...doc.elements()]).toHaveLength(count)

    const missing = await placeLibraryItem(
      engine,
      catalog,
      placeInputOf(
        item({ id: 'lib_2', name: '路人', images: [{ slot: 'main', assetId: 'f'.repeat(64) }] }),
      )!,
    )
    expect(missing.notice).toContain('1 个素材在本机资产里找不到')
  })

  it('特效：参考视频连进卡片，描述写进设定；同名时提醒', async () => {
    const { doc, engine } = setup()
    await placeLibraryItem(engine, catalog, placeInputOf(item())!)
    const r = await placeLibraryItem(
      engine,
      catalog,
      placeInputOf(
        item({ id: 'lib_3', kind: 'effect', name: '林夏', voice: null, images: [], video: V }),
      )!,
    )
    const card = doc.get(r.id!)!
    expect(card.nodeType).toBe('plein/effect')
    expect(card.params?.voice).toBeUndefined()
    const src = [...doc.edges()].find((e) => e.to[0] === r.id)!
    expect(doc.get(src.from[0])).toMatchObject({ kind: 'video', assetId: V })
    expect(r.notice).toContain('同名')
    expect(cardSnapshot(engine, card, null)!.body.video).toBe(V)
  })

  it('存入资产库：没关联时新建并记下 id，关联后更新且保留原槽位', async () => {
    const { doc, engine } = setup()
    const r = await placeLibraryItem(engine, catalog, {
      kind: libraryKind('scene')!,
      name: '天台',
      description: '雨夜',
      images: [{ slot: 'main', assetId: A }],
    })
    const created: LibraryItem[] = []
    const lib = {
      items: created,
      create: vi.fn(async (body) => {
        const it = item({
          ...body,
          id: 'lib_9',
          kind: 'scene',
          voice: null,
        } as Partial<LibraryItem>)
        created.push(it)
        return it
      }),
      update: vi.fn(async (_id: string, body) => ({ ...created[0]!, ...body }) as LibraryItem),
    }
    const first = await saveCardToLibrary(engine, doc.get(r.id!)!, 'pj_1', lib)
    expect(first.created).toBe(true)
    expect(doc.get(r.id!)!.params?.libraryId).toBe('lib_9')

    // 用户在资产库里把 A 挪到了「全景」槽位，再从卡片更新回去不应被改回去
    created[0] = { ...created[0]!, images: [{ slot: 'panorama', assetId: A }] }
    const second = await saveCardToLibrary(engine, doc.get(r.id!)!, 'pj_1', lib)
    expect(second.created).toBe(false)
    expect(lib.update).toHaveBeenCalledWith(
      'lib_9',
      expect.objectContaining({
        images: [{ slot: 'panorama', assetId: A }],
      }),
    )
  })

  it('参考图分槽位：第一张进第一个槽位，其余进可多张的槽位，单张槽位只留一张', () => {
    expect(slotImages(libraryKind('character')!, [A, B, A])).toEqual([
      { slot: 'main', assetId: A },
      { slot: 'extra', assetId: B },
    ])
    expect(slotImages(libraryKind('effect')!, [A, B])).toEqual([{ slot: 'cover', assetId: A }])
  })
})

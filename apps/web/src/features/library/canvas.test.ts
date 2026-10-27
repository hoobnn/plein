import type { Engine } from '@plein/canvas-core'
import { createDoc, setParam, deleteElements } from '@plein/doc'
import { corePlugin, libraryKind } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Asset, Catalog, LibraryItem } from '@plein/protocol'
import { describe, expect, it, vi } from 'vite-plus/test'
import { ApiError, api } from '../../api/client'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const V = 'c'.repeat(64)

vi.mock('../../api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api/client')>()
  return {
    ...original,
    api: {
      assetMeta: vi.fn(async (id: string): Promise<Asset> => {
        if (id === 'f'.repeat(64)) throw new original.ApiError(404, 'not_found', 'not found')
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
      }),
    },
  }
})

const { cardSnapshot, placeLibraryItem, placeInputOf, saveCardToLibrary } = await import('./canvas')

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
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})

describe('资产库 ↔ 画布', () => {
  it.each(['current', 'left', 'deleted', 'relinked', 'readonly'] as const)(
    '服务端存档返回后只为仍有效来源补关联：%s',
    async (state) => {
      const { doc, engine } = setup()
      const placed = await placeLibraryItem(engine, catalog, {
        kind: libraryKind('scene')!,
        name: '天台',
        description: '提交设定',
        images: [],
      })
      let finish!: (value: { item: LibraryItem; created: boolean; persistence: 'saved' }) => void
      const lib = {
        items: [],
        create: vi.fn(),
        update: vi.fn(),
        saveCard: vi.fn(
          () =>
            new Promise<{ item: LibraryItem; created: boolean; persistence: 'saved' }>(
              (resolve) => {
                finish = resolve
              },
            ),
        ),
      }
      const saving = saveCardToLibrary(engine, doc.get(placed.id!)!, 'project', lib, {
        canvasId: 'source',
        current: () => state !== 'left',
      })
      expect(lib.saveCard).toHaveBeenCalledWith(
        expect.objectContaining({
          canvasId: 'source',
          nodeId: placed.id,
          expectedLibraryId: null,
          snapshot: expect.objectContaining({ name: '天台', description: '提交设定' }),
        }),
      )
      if (state === 'deleted') deleteElements(doc, [placed.id!])
      if (state === 'relinked') setParam(doc, placed.id!, 'libraryId', 'other')
      if (state === 'readonly') doc.readOnly = true
      finish({ item: item(), created: true, persistence: 'saved' })
      await saving
      expect(doc.get(placed.id!)?.params?.libraryId).toBe(
        state === 'current' ? 'lib_1' : state === 'relinked' ? 'other' : undefined,
      )
      expect(lib.create).not.toHaveBeenCalled()
      expect(lib.update).not.toHaveBeenCalled()
      if (state === 'readonly')
        await expect(saveCardToLibrary(engine, doc.get(placed.id!)!, null, lib)).rejects.toThrow(
          '只读',
        )
    },
  )

  it.each([403, 429, 503, 'network'])(
    '素材读取失败 %s 不降级为空参考卡片，重试后完整放入',
    async (status) => {
      const { doc, engine, selected } = setup()
      const asset =
        typeof status === 'number' ? status.toString(16).padStart(64, '0') : 'e'.repeat(64)
      const error =
        typeof status === 'number'
          ? new ApiError(status, 'test_failure', '素材读取失败')
          : new TypeError('Failed to fetch')
      vi.mocked(api.assetMeta).mockRejectedValueOnce(error)
      const input = placeInputOf(
        item({
          images: [
            { slot: 'main', assetId: A },
            { slot: 'extra', assetId: asset },
          ],
        }),
      )!
      await expect(placeLibraryItem(engine, catalog, input)).rejects.toBe(error)
      expect([...doc.elements()]).toEqual([])
      expect([...doc.edges()]).toEqual([])
      expect(selected()).toEqual([])
      const result = await placeLibraryItem(engine, catalog, input)
      expect(result.id).toBeTruthy()
      expect([...doc.edges()].map((edge) => doc.get(edge.from[0])?.assetId)).toEqual([A, asset])
    },
  )
  it('并发放入同一条资产只创建一张卡片和一组素材连线', async () => {
    const { doc, engine } = setup()
    const [first, second] = await Promise.all([
      placeLibraryItem(engine, catalog, placeInputOf(item())!),
      placeLibraryItem(engine, catalog, placeInputOf(item())!),
    ])
    expect(second.id).toBe(first.id)
    expect([...doc.elements()].filter((el) => el.params?.libraryId === 'lib_1')).toHaveLength(1)
    expect([...doc.edges()]).toHaveLength(2)
  })
  it.each(['left', 'readonly'])('等待素材时 %s 不创建节点、连线或改选区', async (reason) => {
    const { doc, engine, selected } = setup()
    let current = true
    const placing = placeLibraryItem(engine, catalog, placeInputOf(item())!, () => current)
    if (reason === 'left') current = false
    else doc.readOnly = true
    const result = await placing
    expect(result.id).toBeNull()
    expect(result.notice).toBe(reason === 'left' ? '' : '当前画布只读，无法放入资产')
    expect([...doc.elements()]).toEqual([])
    expect([...doc.edges()]).toEqual([])
    expect(selected()).toEqual([])
  })
  it('开始时已失效或只读也不放置，重新获得写入权限后可正常重试', async () => {
    const { doc, engine } = setup()
    expect(
      (await placeLibraryItem(engine, catalog, placeInputOf(item())!, () => false)).id,
    ).toBeNull()
    doc.readOnly = true
    expect((await placeLibraryItem(engine, catalog, placeInputOf(item())!)).notice).toContain(
      '只读',
    )
    doc.readOnly = false
    expect((await placeLibraryItem(engine, catalog, placeInputOf(item())!)).id).toBeTruthy()
  })
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
        { slot: 'full_body', assetId: A },
        { slot: 'extra', assetId: B },
      ],
    })
  })

  it('同一图用于多个角色分类时只放一次，存回资产库仍保留全部用途', async () => {
    const { doc, engine } = setup()
    const original = item({
      images: [
        { slot: 'full_body', assetId: A },
        { slot: 'portrait', assetId: A },
        { slot: 'character_3view', assetId: B },
        { slot: 'face_grid', assetId: B },
        { slot: 'head_3view', assetId: A },
      ],
    })
    const placed = await placeLibraryItem(engine, catalog, placeInputOf(original)!)
    expect(placed.notice).not.toContain('找不到')
    const references = [...doc.edges()].filter((edge) => edge.to[0] === placed.id)
    expect(references.map((edge) => doc.get(edge.from[0])?.assetId)).toEqual([A, B])
    const update = vi.fn(async (_id: string, body) => ({ ...original, ...body }) as LibraryItem)
    const saved = await saveCardToLibrary(engine, doc.get(placed.id!)!, null, {
      items: [original],
      create: vi.fn(),
      update,
    })
    expect(saved.item.images).toHaveLength(5)
    expect(saved.item.images).toEqual(expect.arrayContaining(original.images))
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

  it('场景视角素材缺失单独提示，且不变成基础参考连线', async () => {
    const { doc, engine } = setup()
    const placed = await placeLibraryItem(
      engine,
      catalog,
      placeInputOf(
        item({
          id: 'lib_scene',
          kind: 'scene',
          name: '教室',
          images: [],
          sceneViews: [
            {
              id: 'door',
              name: '门口',
              aliases: [],
              description: '',
              images: [A, 'f'.repeat(64), V],
              panorama: {
                assetId: 'f'.repeat(64),
                yaw: 0,
                pitch: 0,
                fov: 55,
                format: 'landscape',
              },
            },
          ],
        }),
      )!,
    )
    expect(placed.notice).toContain('2 个视角素材')
    expect(placed.notice).not.toContain('已跳过')
    expect([...doc.elements()]).toHaveLength(1)
    expect([...doc.edges()].filter((edge) => edge.to[0] === placed.id)).toEqual([])
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
})

import {
  type CardRef,
  cardSnapshot as cardSnapshotIn,
  findPlacedCard as findPlacedCardIn,
  placeLibraryCard,
  REF_COL_GAP,
  REF_W,
  refsHeight,
} from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, setParam, findFreeSpot } from '@plein/doc'
import {
  type LibraryKindSpec,
  libraryKind,
  orderedImages,
  preserveLibraryImageSlots,
  profileImages,
  sceneViewAssets,
  sceneViewImages,
  slotImages,
} from '@plein/nodes'
import type {
  Asset,
  Catalog,
  CreateLibraryItem,
  LibraryItem,
  SaveLibraryCard,
  SaveLibraryCardResult,
} from '@plein/protocol'
import { ApiError, assetUrls } from '../../api/client'
import { loadAssetMeta } from '../../stores/assetMeta'
import type { LibrarySeed } from './store'
import { mediaOf } from '../../canvas/grid'
import { findNode, mentionTargets, nodeElement } from '../../canvas/nodes'

/**
 * 资产库与画布之间的往返：
 * - 用到画布上：展开成一张卡片节点（设定、音色写进参数），参考图 / 参考视频作为素材元素连进卡片；
 * - 存入资产库：卡片的名字、设定、音色和连入的参考图存成条目，卡片记下条目 id，之后可以更新回去。
 * 卡片参数里的 libraryId 只是来源记录，不参与生成。
 */

/** 用到画布上的内容：资产库条目，或只有提示词的官方条目 */
export interface PlaceInput {
  kind: LibraryKindSpec
  name: string
  description: string
  voice?: LibraryItem['voice']
  profile?: LibraryItem['profile']
  sceneViews?: LibraryItem['sceneViews']
  images?: LibraryItem['images']
  video?: string | null
  /** 资产库条目 id；官方条目没有 */
  libraryId?: string
  /** 制作草稿使用当前资产的新副本，保留画布上已有的旧版本。 */
  fresh?: boolean
}

export interface PlaceResult {
  id: string | null
  /** 给用户的一句话 */
  notice: string
}

/** 素材在卡片左侧排成一列，宽度统一 */

/** 画布上已经有这条资产展开出来的卡片 */
export const findPlacedCard = (engine: Engine, libraryId: string) =>
  findPlacedCardIn(engine.doc, libraryId)

type CoverInput = Pick<
  LibraryItem,
  'kind' | 'images' | 'profile' | 'sceneViews' | 'video' | 'coverAssetId'
>

/** 独立封面必须仍指向条目中的有效素材；移除素材后回退，不显示悬空 ID。 */
export function coverAssetOf(item: CoverInput, kind = libraryKind(item.kind)) {
  const id = item.coverAssetId
  if (!id) return null
  const valid = kind?.id === 'character' && item.images.some((image) => image.assetId === id)
  return valid ? id : null
}

/** 条目封面：优先有效独立封面，再按基础参考、档案图片与视频封面回退。 */
export function coverOf(item: LibraryItem, kind = libraryKind(item.kind)) {
  const explicit = coverAssetOf(item, kind)
  if (explicit) return assetUrls.variant(explicit, 'thumb-256')
  const first = kind && orderedImages(kind, item.images)[0]
  if (first) return assetUrls.variant(first.assetId, 'thumb-256')
  const profile = kind?.id === 'character' && item.profile && profileImages(item.profile)[0]
  if (profile) return assetUrls.variant(profile, 'thumb-256')
  const scene = kind?.id === 'scene' ? sceneViewImages(item.sceneViews)[0] : undefined
  if (scene) return assetUrls.variant(scene, 'thumb-256')
  if (item.video) return assetUrls.variant(item.video, 'poster')
  return null
}

async function metas(ids: string[]) {
  const out = await Promise.all(
    ids.map((id) =>
      loadAssetMeta(id).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null
        throw error
      }),
    ),
  )
  return out.filter((a): a is Asset => a !== null)
}

/** 把资产展开到画布视口中央；同一条资产已经在画布上时直接选中它，不重复铺 */
export async function placeLibraryItem(
  engine: Engine,
  catalog: Catalog | null,
  input: PlaceInput,
  isCurrent: () => boolean = () => true,
): Promise<PlaceResult> {
  const { kind } = input
  const unavailable = (): PlaceResult => ({
    id: null,
    notice: isCurrent() ? '当前画布只读，无法放入资产' : '',
  })
  if (!isCurrent() || engine.doc.readOnly) return unavailable()
  const selectPlaced = (): PlaceResult | undefined => {
    if (input.fresh) return undefined
    const placed = input.libraryId && findPlacedCard(engine, input.libraryId)
    if (placed) {
      engine.selection.set([placed.id])
      const r = engine.scene.rect(placed.id)
      if (r) engine.camera.centerOn(r.x + r.w / 2, r.y + r.h / 2)
      return { id: placed.id, notice: `「${placed.name}」已经在画布上，已为你选中` }
    }
  }
  const existing = selectPlaced()
  if (existing) return existing
  const info = findNode(catalog, kind.nodeType)
  if (!info) return { id: null, notice: `当前没有「${kind.title}」卡片节点，无法放到画布上` }

  const imageIds = orderedImages(kind, input.images ?? []).map((i) => i.assetId)
  const requested = [...new Set([...imageIds, ...(input.video ? [input.video] : [])])]
  const viewRequested =
    kind.id === 'scene'
      ? sceneViewAssets(input.sceneViews).filter((assetId) => !requested.includes(assetId))
      : []
  const [assets, viewAssets] = await Promise.all([metas(requested), metas(viewRequested)])
  // 元信息等待期间可能离开画布、变为只读，或另一入口已完成放置。
  if (!isCurrent() || engine.doc.readOnly) return unavailable()
  const concurrent = selectPlaced()
  if (concurrent) return concurrent
  const missing = requested.length - assets.length
  const missingViews = viewRequested.length - viewAssets.filter((a) => a.kind === 'image').length

  const view = engine.camera.viewRect
  const base = nodeElement(info)
  const refs: CardRef[] = assets.flatMap((a) =>
    a.kind === 'image' || a.kind === 'video'
      ? [{ kind: a.kind, assetId: a.id, name: a.name, width: a.width, height: a.height }]
      : [],
  )
  // 卡片 + 左侧素材列一起找空地，从视口中央往右挪，不压住已有元素
  const left = assets.length ? REF_W + REF_COL_GAP : 0
  const height = Math.max(base.h, refsHeight(refs))
  const spot = findFreeSpot(engine.doc, {
    x: Math.round(view.x + view.w / 2 - (base.w + left) / 2),
    y: Math.round(view.y + view.h / 2 - height / 2),
    w: base.w + left,
    h: height,
  })
  const card = { x: spot.x + left, y: spot.y + (height - base.h) / 2 }
  const params: Record<string, unknown> = {
    ...base.params,
    description: input.description,
    ...(kind.voice && input.voice ? { voice: input.voice } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(kind.id === 'scene' ? { sceneViews: input.sceneViews ?? [] } : {}),
    ...(input.libraryId ? { libraryId: input.libraryId } : {}),
  }
  const names = new Set(mentionTargets(engine).map((target) => target.name))
  let cardName = input.name
  if (input.fresh) {
    const stem = `${input.name} · 制作参考`
    cardName = stem
    for (let n = 2; names.has(cardName); n++) cardName = `${stem} ${n}`
  }
  const duplicate = names.has(cardName)

  const { id: cardId, loose } = placeLibraryCard(
    engine.doc,
    { ...base, name: cardName, params },
    card,
    refs,
  )
  engine.selection.set([cardId])
  engine.setTool('select')
  // 为了不压住已有元素挪出了视口时，镜头跟过去
  if (card.x - left < view.x || card.x + base.w > view.x + view.w)
    engine.camera.centerOn(card.x + (base.w - left) / 2, card.y + base.h / 2)

  const notes: string[] = []
  if (missing > 0) notes.push(`${missing} 个素材在本机资产里找不到，已跳过`)
  if (missingViews > 0)
    notes.push(`${missingViews} 个视角素材在本机资产里找不到或类型不符，使用对应视角前请修复`)
  if (loose > 0) notes.push(`${loose} 个素材没能连进卡片，请手动连线`)
  if (duplicate) notes.push(`画布上已有同名「${input.name}」，@ 引用时要写序号区分，建议改名`)
  return {
    id: cardId,
    notice: `已放入${kind.title}「${input.name}」${notes.length ? `：${notes.join('；')}` : ''}`,
  }
}

/** 卡片当前内容，整理成资产库条目 */
export const cardSnapshot = (engine: Engine, el: CanvasElement, projectId: string | null) =>
  cardSnapshotIn(engine.doc, el, projectId)

/**
 * 卡片存入资产库：卡片记着条目 id 且条目还在时更新它（保留已有图片的槽位、标签和收藏），
 * 否则新建一条并把 id 记到卡片上。
 */
export async function saveCardToLibrary(
  engine: Engine,
  el: CanvasElement,
  projectId: string | null,
  lib: {
    items: LibraryItem[]
    create(body: CreateLibraryItem): Promise<LibraryItem>
    update(id: string, body: Partial<CreateLibraryItem>): Promise<LibraryItem>
    saveCard?(body: SaveLibraryCard): Promise<SaveLibraryCardResult>
  },
  source?: { canvasId: string; current(): boolean },
): Promise<{ item: LibraryItem; created: boolean; persistence?: 'saved' | 'pending' }> {
  if (engine.doc.readOnly) throw new Error('当前画布只读，不能存入资产库')
  const snap = cardSnapshot(engine, el, projectId)
  if (!snap) throw new Error('这个节点不是资产卡')
  const { body } = snap
  if (source && lib.saveCard) {
    const expectedLibraryId = typeof el.params?.libraryId === 'string' ? el.params.libraryId : null
    const saved = await lib.saveCard({
      canvasId: source.canvasId,
      nodeId: el.id,
      expectedLibraryId,
      snapshot: body,
    })
    if (source.current() && !engine.doc.readOnly) {
      const current = engine.doc.get(el.id)
      const linked =
        typeof current?.params?.libraryId === 'string' ? current.params.libraryId : null
      if (current?.nodeType === el.nodeType && linked === expectedLibraryId)
        setParam(engine.doc, el.id, 'libraryId', saved.item.id)
    }
    return saved
  }
  const linked = lib.items.find((i) => i.id === el.params?.libraryId)
  if (linked) {
    const images = preserveLibraryImageSlots(linked.kind, body.images ?? [], linked.images)
    const item = await lib.update(linked.id, {
      name: body.name,
      description: body.description,
      // 资产库里手选过的标签优先，没选的按设定补上
      tags: { ...body.tags, ...nonEmpty(linked.tags) },
      images,
      video: body.video,
      voice: body.voice,
      profile: body.profile,
      sceneViews: body.sceneViews,
    })
    return { item, created: false }
  }
  const item = await lib.create(body)
  setParam(engine.doc, el.id, 'libraryId', item.id)
  return { item, created: true }
}

const nonEmpty = (tags: Record<string, string>) =>
  Object.fromEntries(Object.entries(tags).filter(([, v]) => v))

/** 资产库条目 → 放到画布上的输入 */
export function placeInputOf(item: LibraryItem): PlaceInput | null {
  const kind = libraryKind(item.kind)
  if (!kind) return null
  return {
    kind,
    name: item.name,
    description: item.description,
    voice: item.voice,
    profile: item.profile,
    sceneViews: item.sceneViews,
    images: item.images,
    video: item.video,
    libraryId: item.id,
  }
}

/** 画布上的一份图片 / 视频：素材元素，或生成节点当前采用的结果 */
export interface CanvasMedia {
  elId: string
  assetId: string
  kind: 'image' | 'video'
  name: string
}

/** 这些元素（含 Frame 里的）展示的图片和视频，按资产去重 */
export function mediaIn(engine: Engine, ids: readonly string[]): CanvasMedia[] {
  const seen = new Set<string>()
  const out: CanvasMedia[] = []
  for (const id of ids)
    for (const el of [engine.doc.get(id), ...engine.doc.descendants(id)]) {
      const m = el && mediaOf(el)
      if (!el || !m || seen.has(m.assetId)) continue
      seen.add(m.assetId)
      out.push({ elId: el.id, ...m, name: el.name ?? '' })
    }
  return out
}

/** 整张画布上的图片 / 视频，给资产库「从画布选」用 */
export function canvasMedia(engine: Engine): CanvasMedia[] {
  return mediaIn(
    engine,
    [...engine.doc.elements()].map((el) => el.id),
  )
}

/** 选中内容 → 资产库新建表单的预填；只有一个素材时用它的名字 */
export function seedOf(media: readonly CanvasMedia[]): LibrarySeed {
  return {
    name: media.length === 1 ? media[0]!.name : undefined,
    images: media.filter((m) => m.kind === 'image').map((m) => m.assetId),
    videos: media.filter((m) => m.kind === 'video').map((m) => m.assetId),
  }
}

/** 预填前检查类别容量，不让草稿初始化静默丢弃选中的素材。 */
export function librarySeedIssue(kind: LibraryKindSpec, seed: LibrarySeed): string | null {
  const videos = new Set(seed.videos).size
  if (videos && !kind.video) return `${kind.title}只收图片，请先取消选择视频`
  if (videos > 1) return `每条${kind.title}只能保存 1 个参考视频，请先只选 1 个视频`
  if (slotImages(kind, seed.images).length < new Set(seed.images).size)
    return `每条${kind.title}只能保存 1 张${kind.slots[0]!.label}，请先只选 1 张图片`
  return null
}

/** 类别菜单绑定素材身份和顺序；改名不改变素材，预填时再读最新名称。 */
export function mediaSelectionKey(media: readonly CanvasMedia[]) {
  return JSON.stringify(media.map((item) => [item.elId, item.assetId, item.kind]))
}

/** 点击菜单时再读当前文档与选区，拒绝旧菜单在同一帧里提交已变化的素材。 */
export function selectionSeed(
  engine: Engine,
  expected: readonly CanvasMedia[],
): LibrarySeed | null {
  if (!expected.length) return null
  const current = mediaIn(engine, engine.selection.values())
  return mediaSelectionKey(current) === mediaSelectionKey(expected) ? seedOf(current) : null
}

import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  createElement,
  currentResult,
  type NewElement,
  setParam,
} from '@plein/doc'
import {
  type LibraryKindSpec,
  libraryKind,
  libraryKindOfNode,
  orderedImages,
  slotImages,
  voiceOf,
} from '@plein/nodes'
import type { Asset, Catalog, CreateLibraryItem, LibraryItem } from '@plein/protocol'
import { assetUrls } from '../api/client'
import { loadAssetMeta } from '../stores/assetMeta'
import type { LibrarySeed } from '../stores/library'
import { mediaOf } from './grid'
import { elementFor } from './import'
import { findNode, mentionTargets, nodeElement } from './nodes'
import { outputPort } from './presets'

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
  images?: LibraryItem['images']
  video?: string | null
  /** 资产库条目 id；官方条目没有 */
  libraryId?: string
}

export interface PlaceResult {
  id: string | null
  /** 给用户的一句话 */
  notice: string
}

/** 素材在卡片左侧排成一列，宽度统一 */
const REF_W = 180
const REF_GAP = 24
const COL_GAP = 80

/** 画布上已经有这条资产展开出来的卡片 */
export function findPlacedCard(engine: Engine, libraryId: string) {
  for (const el of engine.doc.elements())
    if (el.kind === 'node' && el.params?.libraryId === libraryId) return el
  return undefined
}

/** 从 at 起往右找一块放得下 [x-left, x+w] × [y, y+h] 的空地，返回卡片左上角 */
function freeSpot(
  engine: Engine,
  at: { x: number; y: number; left: number; w: number; h: number },
) {
  let { x } = at
  for (let i = 0; i < 20; i++) {
    const box = { x: x - at.left, y: at.y, w: at.left + at.w, h: at.h }
    const hits = (engine.scene.query?.(box) ?? []).filter(
      (id) => engine.scene.get(id)?.kind !== 'frame',
    )
    if (!hits.length) break
    const right = Math.max(
      ...hits.map((id) => {
        const r = engine.scene.rect(id)
        return r ? r.x + r.w : x
      }),
    )
    x = Math.round(right + 80 + at.left)
  }
  return { x, y: at.y }
}

/** 条目封面：第一张参考图的缩略图，没有图时用参考视频的封面 */
export function coverOf(item: LibraryItem, kind = libraryKind(item.kind)) {
  const first = kind && orderedImages(kind, item.images)[0]
  if (first) return assetUrls.variant(first.assetId, 'thumb-256')
  if (item.video) return assetUrls.variant(item.video, 'poster')
  return null
}

async function metas(ids: string[]) {
  const out = await Promise.all(ids.map((id) => loadAssetMeta(id).catch(() => null)))
  return out.filter((a): a is Asset => a !== null)
}

/** 把资产展开到画布视口中央；同一条资产已经在画布上时直接选中它，不重复铺 */
export async function placeLibraryItem(
  engine: Engine,
  catalog: Catalog | null,
  input: PlaceInput,
): Promise<PlaceResult> {
  const { kind } = input
  if (input.libraryId) {
    const placed = findPlacedCard(engine, input.libraryId)
    if (placed) {
      engine.selection.set([placed.id])
      const r = engine.scene.rect(placed.id)
      if (r) engine.camera.centerOn(r.x + r.w / 2, r.y + r.h / 2)
      return { id: placed.id, notice: `「${placed.name}」已经在画布上，已为你选中` }
    }
  }
  const info = findNode(catalog, kind.nodeType)
  if (!info) return { id: null, notice: `当前没有「${kind.title}」卡片节点，无法放到画布上` }

  const imageIds = orderedImages(kind, input.images ?? []).map((i) => i.assetId)
  const assets = await metas([...new Set(imageIds), ...(input.video ? [input.video] : [])])
  const missing = imageIds.length + (input.video ? 1 : 0) - assets.length

  const view = engine.camera.viewRect
  const base = nodeElement(info)
  // 卡片 + 左侧素材列一起找空地，从视口中央往右挪，不压住已有元素
  const left = assets.length ? REF_W + COL_GAP : 0
  const card = freeSpot(engine, {
    x: Math.round(view.x + view.w / 2 - (base.w - left) / 2),
    y: Math.round(view.y + view.h / 2 - base.h / 2),
    left,
    w: base.w,
    h: Math.max(base.h, 400),
  })
  const params: Record<string, unknown> = {
    ...base.params,
    description: input.description,
    ...(kind.voice && input.voice ? { voice: input.voice } : {}),
    ...(input.libraryId ? { libraryId: input.libraryId } : {}),
  }
  const duplicate = mentionTargets(engine).some((t) => t.name === input.name)

  let cardId = ''
  let loose = 0
  engine.doc.ydoc.transact(() => {
    cardId = createElement(engine.doc, {
      ...base,
      name: input.name,
      x: card.x,
      y: card.y,
      params,
    } as NewElement)
    // 素材列以卡片竖直居中
    const sized = assets.flatMap((a) => {
      const el = elementFor(a)
      if (!el) return []
      const h = Math.round((el.h / el.w) * REF_W)
      return [{ el: { ...el, w: REF_W, h }, asset: a }]
    })
    const total = sized.reduce((s, x) => s + x.el.h, 0) + REF_GAP * Math.max(0, sized.length - 1)
    let y = card.y + base.h / 2 - total / 2
    for (const { el } of sized) {
      const id = createElement(engine.doc, {
        ...el,
        x: card.x - COL_GAP - REF_W,
        y: Math.round(y),
      } as NewElement)
      y += el.h + REF_GAP
      const created = engine.doc.get(id)
      const port = created && outputPort(created, el.kind === 'video' ? 'video' : 'image')
      if (!port || !connect(engine.doc, [id, port.id], [cardId, 'references'])) loose++
    }
  }, engine.doc.origin)
  engine.doc.flush()
  engine.selection.set([cardId])
  engine.setTool('select')
  // 为了不压住已有元素挪出了视口时，镜头跟过去
  if (card.x - left < view.x || card.x + base.w > view.x + view.w)
    engine.camera.centerOn(card.x + (base.w - left) / 2, card.y + base.h / 2)

  const notes: string[] = []
  if (missing > 0) notes.push(`${missing} 个素材在本机资产里找不到，已跳过`)
  if (loose > 0) notes.push(`${loose} 个素材没能连进卡片，请手动连线`)
  if (duplicate) notes.push(`画布上已有同名「${input.name}」，@ 引用时要写序号区分，建议改名`)
  return {
    id: cardId,
    notice: `已放入${kind.title}「${input.name}」${notes.length ? `：${notes.join('；')}` : ''}`,
  }
}

/** 卡片连入 references 的素材：素材元素或上游节点当前采用的结果 */
function referenceAssets(engine: Engine, el: CanvasElement, type: 'image' | 'video') {
  return [...engine.doc.edges()]
    .filter((e) => e.to[0] === el.id && e.to[1] === 'references')
    .flatMap((e) => {
      const src = engine.doc.get(e.from[0])
      if (src?.kind === type && src.assetId) return [src.assetId]
      const r = src?.kind === 'node' ? currentResult(src, e.from[1])?.value : undefined
      return r?.type === type ? [r.assetId] : []
    })
}

/** 卡片当前内容，整理成资产库条目 */
export function cardSnapshot(engine: Engine, el: CanvasElement, projectId: string | null) {
  const kind = libraryKindOfNode(el.nodeType)
  if (!kind) return null
  const images = slotImages(kind, referenceAssets(engine, el, 'image'))
  const videos = kind.video ? referenceAssets(engine, el, 'video') : []
  const voice = kind.voice ? voiceOf(el.params) : null
  const body: CreateLibraryItem = {
    kind: kind.id,
    name: (el.name ?? kind.title).trim().slice(0, 60) || kind.title,
    projectId,
    description: String(el.params?.description ?? ''),
    images,
    video: videos[0] ?? null,
    voice: voice?.voiceId ? voice : null,
  }
  return { kind, body }
}

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
  },
): Promise<{ item: LibraryItem; created: boolean }> {
  const snap = cardSnapshot(engine, el, projectId)
  if (!snap) throw new Error('这个节点不是资产卡')
  const { body } = snap
  const linked = lib.items.find((i) => i.id === el.params?.libraryId)
  if (linked) {
    const slots = new Map(linked.images.map((i) => [i.assetId, i.slot]))
    const images = body.images?.map((i) => ({ ...i, slot: slots.get(i.assetId) ?? i.slot }))
    const item = await lib.update(linked.id, {
      name: body.name,
      description: body.description,
      images,
      video: body.video,
      voice: body.voice,
    })
    return { item, created: false }
  }
  const item = await lib.create(body)
  setParam(engine.doc, el.id, 'libraryId', item.id)
  return { item, created: true }
}

/** 资产库条目 → 放到画布上的输入 */
export function placeInputOf(item: LibraryItem): PlaceInput | null {
  const kind = libraryKind(item.kind)
  if (!kind) return null
  return {
    kind,
    name: item.name,
    description: item.description,
    voice: item.voice,
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

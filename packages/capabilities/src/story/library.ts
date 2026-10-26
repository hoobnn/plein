import {
  type CanvasElement,
  connect,
  createElement,
  currentResult,
  elementPorts,
  inputEdges,
  type NewElement,
  type PleinDoc,
} from '@plein/doc'
import {
  characterTags,
  type LibraryKindSpec,
  libraryKindOfNode,
  profileEmpty,
  profileOf,
  sceneViewsOf,
  slotImages,
  voiceOf,
} from '@plein/nodes'

/**
 * 资产库与画布之间的往返（纯文档部分）：
 * - 用到画布上：一张卡片节点（设定、音色写进参数），参考图 / 参考视频作为素材元素排在左侧连进卡片；
 * - 存入资产库：卡片的名字、设定、音色和连入的参考图整理成条目。
 */

/** 素材在卡片左侧排成一列，宽度统一 */
export const REF_W = 180
const REF_GAP = 24
export const REF_COL_GAP = 80

/** 卡片左侧的一份参考素材 */
export interface CardRef {
  kind: 'image' | 'video'
  assetId: string
  name?: string
  width?: number
  height?: number
}

/** 画布上已经有这条资产展开出来的卡片 */
export function findPlacedCard(doc: PleinDoc, libraryId: string) {
  for (const el of doc.elements())
    if (el.kind === 'node' && el.params?.libraryId === libraryId) return el
  return undefined
}

/**
 * 建卡片和左侧素材列（以卡片竖直居中），素材连进卡片的 references。
 * at 是卡片左上角；整个操作一步撤销。返回卡片 id 和没连上的素材数。
 */
export function placeLibraryCard(
  doc: PleinDoc,
  card: Omit<NewElement, 'x' | 'y'> & { w: number; h: number },
  at: { x: number; y: number },
  refs: CardRef[],
): { id: string; loose: number } {
  let out = { id: '', loose: 0 }
  doc.ydoc.transact(() => {
    out = addCardWithRefs(doc, card, at, refs)
  }, doc.origin)
  doc.flush()
  return out
}

const refHeight = (r: CardRef) => {
  const ratio = r.width && r.height ? r.height / r.width : r.kind === 'video' ? 9 / 16 : 1
  return Math.round(ratio * REF_W)
}

/** 卡片左侧素材列的总高度 */
export const refsHeight = (refs: readonly CardRef[]) =>
  refs.reduce((s, r) => s + refHeight(r), 0) + REF_GAP * Math.max(0, refs.length - 1)

/** placeLibraryCard 的文档操作本身，不开事务：给已经在事务里的调用方（如生成设定卡）用 */
export function addCardWithRefs(
  doc: PleinDoc,
  card: Omit<NewElement, 'x' | 'y'> & { w: number; h: number },
  at: { x: number; y: number },
  refs: readonly CardRef[],
): { id: string; loose: number } {
  let loose = 0
  const id = createElement(doc, { ...card, x: Math.round(at.x), y: Math.round(at.y) } as NewElement)
  let y = at.y + card.h / 2 - refsHeight(refs) / 2
  for (const r of refs) {
    const h = refHeight(r)
    const ref = createElement(doc, {
      kind: r.kind,
      assetId: r.assetId,
      name: r.name,
      x: at.x - REF_COL_GAP - REF_W,
      y: Math.round(y),
      w: REF_W,
      h,
    } as NewElement)
    y += h + REF_GAP
    const created = doc.get(ref)
    const port = created && elementPorts(created)?.outputs.find((p) => p.type === r.kind)
    if (!port || !connect(doc, [ref, port.id], [id, 'references'])) loose++
  }
  return { id, loose }
}

/** 卡片连入 references 的素材：素材元素或上游节点当前采用的结果 */
export function referenceAssets(doc: PleinDoc, el: CanvasElement, type: 'image' | 'video') {
  return inputEdges(doc, el.id, 'references').flatMap((e) => {
    const src = doc.get(e.from[0])
    if (src?.kind === type && src.assetId) return [src.assetId]
    const r = src?.kind === 'node' ? currentResult(src, e.from[1])?.value : undefined
    return r?.type === type ? [r.assetId] : []
  })
}

/** 卡片当前内容，整理成资产库条目；不是资产卡时返回 null */
export function cardSnapshot(doc: PleinDoc, el: CanvasElement, projectId: string | null) {
  const kind: LibraryKindSpec | undefined = libraryKindOfNode(el.nodeType)
  if (!kind) return null
  const images = slotImages(kind, referenceAssets(doc, el, 'image'))
  const videos = kind.video ? referenceAssets(doc, el, 'video') : []
  const voice = kind.voice ? voiceOf(el.params) : null
  const name = (el.name ?? kind.title).trim().slice(0, 60) || kind.title
  const description = String(el.params?.description ?? '')
  const profile = kind.id === 'character' ? profileOf(el.params?.profile) : null
  return {
    kind,
    body: {
      kind: kind.id,
      name,
      projectId,
      description,
      // 角色的性别、年龄段从设定里看出来，资产库里按它筛选
      tags: kind.id === 'character' ? characterTags(name, description) : {},
      images,
      video: videos[0] ?? null,
      voice: voice?.voiceId ? voice : null,
      profile: profile && !profileEmpty(profile) ? profile : null,
      ...(kind.id === 'scene' ? { sceneViews: sceneViewsOf(el.params?.sceneViews) } : {}),
    },
  }
}

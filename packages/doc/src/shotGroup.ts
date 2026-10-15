import { elementMedia, setParam, updateElements } from './commands'
import type { PleinDoc } from './doc'
import type { CanvasElement } from './types'

/**
 * 分镜组：一个 Frame 里的图片按顺序编号，能整组排版、拼成一张大图。
 * 顺序存在 Frame 的参数里；组里的图片照常是画布元素，移出组、减格都不删素材。
 */
export interface ShotGroup {
  /** 元素 id，按镜头顺序；不在组里的 id 读的时候跳过 */
  order: string[]
  /** 排版列数 */
  cols?: number
  /** 由宫格切分得到时记下原图，能从组回到切之前的那张 */
  source?: { elementId: string; rows: number; cols: number }
}

export const SHOT_GROUP_KEY = 'shotGroup'

/** 排版时图片之间、图片到 Frame 边的距离 */
export const SHOT_GAP = 16
export const SHOT_PAD = 32

export function shotGroupOf(el: CanvasElement | undefined): ShotGroup | null {
  const g = el?.kind === 'frame' ? el.params?.[SHOT_GROUP_KEY] : undefined
  if (!g || typeof g !== 'object' || !Array.isArray((g as ShotGroup).order)) return null
  return g as ShotGroup
}

/** 组里能编号的元素：有图片的（素材图或当前结果是图片的节点） */
function isShot(el: CanvasElement) {
  return elementMedia(el)?.kind === 'image'
}

/** 阅读顺序：先上下（按行，半个高度内算同一行）再左右 */
export function readingOrder(els: CanvasElement[]): CanvasElement[] {
  const sorted = [...els].sort((a, b) => a.y - b.y)
  const rows: CanvasElement[][] = []
  for (const el of sorted) {
    const row = rows.at(-1)
    if (row && Math.abs(el.y - row[0]!.y) < Math.min(el.h, row[0]!.h) / 2) row.push(el)
    else rows.push([el])
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x))
}

/**
 * 组里的镜头，按顺序：记过顺序的在前，新放进来的按阅读顺序接在后面；
 * 移出组或删掉的不再出现，但顺序里的记录留着无妨
 */
export function groupShots(doc: PleinDoc, frameId: string): CanvasElement[] {
  const group = shotGroupOf(doc.get(frameId))
  const kids = doc.children(frameId).filter(isShot)
  if (!group) return readingOrder(kids)
  const byId = new Map(kids.map((el) => [el.id, el]))
  const known = group.order.flatMap((id) => {
    const el = byId.get(id)
    if (el) byId.delete(id)
    return el ? [el] : []
  })
  return [...known, ...readingOrder([...byId.values()])]
}

/** 把 Frame 设成分镜组：按现在的阅读顺序编号 */
export function makeShotGroup(
  doc: PleinDoc,
  frameId: string,
  opts: Omit<ShotGroup, 'order'> = {},
): ShotGroup | null {
  if (doc.get(frameId)?.kind !== 'frame') return null
  const order = groupShots(doc, frameId).map((el) => el.id)
  const group: ShotGroup = { ...opts, order }
  setParam(doc, frameId, SHOT_GROUP_KEY, group)
  return group
}

/** 取消分镜组：只去掉编号，图片都在 */
export function clearShotGroup(doc: PleinDoc, frameId: string) {
  setParam(doc, frameId, SHOT_GROUP_KEY, undefined)
}

/** 把一个镜头挪到第 to 位（从 0 起） */
export function moveShot(doc: PleinDoc, frameId: string, id: string, to: number) {
  const group = shotGroupOf(doc.get(frameId))
  if (!group) return
  const order = groupShots(doc, frameId).map((el) => el.id)
  const from = order.indexOf(id)
  if (from < 0) return
  order.splice(from, 1)
  order.splice(Math.max(0, Math.min(order.length, to)), 0, id)
  setParam(doc, frameId, SHOT_GROUP_KEY, { ...group, order })
}

/** 默认列数：接近方阵，横图多放几列 */
export function defaultCols(n: number) {
  return Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n))))
}

/**
 * 按顺序排成网格（每格按组里最大的宽高），Frame 跟着收放到刚好包住；
 * 不改图片大小，只挪位置。返回用的列数
 */
export function layoutShotGroup(doc: PleinDoc, frameId: string, cols?: number): number {
  const frame = doc.get(frameId)
  const shots = groupShots(doc, frameId)
  if (frame?.kind !== 'frame' || !shots.length) return 0
  const group = shotGroupOf(frame)
  const c = Math.max(1, Math.min(shots.length, cols ?? group?.cols ?? defaultCols(shots.length)))
  const rows = Math.ceil(shots.length / c)
  const cellW = Math.max(...shots.map((s) => s.w))
  const cellH = Math.max(...shots.map((s) => s.h))
  doc.ydoc.transact(() => {
    updateElements(
      doc,
      shots.map((s, i) => ({
        id: s.id,
        x: Math.round(SHOT_PAD + (i % c) * (cellW + SHOT_GAP) + (cellW - s.w) / 2),
        y: Math.round(SHOT_PAD + Math.floor(i / c) * (cellH + SHOT_GAP) + (cellH - s.h) / 2),
      })),
    )
    updateElements(doc, [
      {
        id: frameId,
        w: Math.round(SHOT_PAD * 2 + c * cellW + (c - 1) * SHOT_GAP),
        h: Math.round(SHOT_PAD * 2 + rows * cellH + (rows - 1) * SHOT_GAP),
      },
    ])
    if (group)
      setParam(doc, frameId, SHOT_GROUP_KEY, {
        ...group,
        order: shots.map((s) => s.id),
        cols: c,
      })
  }, doc.origin)
  return c
}

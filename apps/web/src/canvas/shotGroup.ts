import type { Engine } from '@plein/canvas-core'
import {
  clearShotGroup,
  createElement,
  elementMedia,
  groupShots,
  layoutShotGroup,
  makeShotGroup,
  moveShot,
  type ShotGroup,
  shotGroupOf,
} from '@plein/doc'
import { api } from '../api/client'
import { freeSpotRight } from './presets'

/** 文档改动算一步撤销 */
function step(engine: Engine, fn: () => void) {
  const { doc } = engine
  doc.undo.stopCapturing()
  doc.ydoc.transact(fn, doc.origin)
  doc.undo.stopCapturing()
}

/** Frame 里有没有能编号的图片 */
export function hasShots(engine: Engine, frameId: string) {
  return groupShots(engine.doc, frameId).length > 0
}

export function setShotGroup(engine: Engine, frameId: string, opts?: Omit<ShotGroup, 'order'>) {
  step(engine, () => void makeShotGroup(engine.doc, frameId, opts))
}

export function unsetShotGroup(engine: Engine, frameId: string) {
  step(engine, () => clearShotGroup(engine.doc, frameId))
}

export function reorderShot(engine: Engine, frameId: string, id: string, to: number) {
  step(engine, () => moveShot(engine.doc, frameId, id, to))
}

/** 按顺序排成 cols 列的网格 */
export function arrangeShots(engine: Engine, frameId: string, cols?: number) {
  step(engine, () => void layoutShotGroup(engine.doc, frameId, cols))
}

/**
 * 拼成大图：服务端按顺序拼，结果作为新图片放在 Frame 右边，名字里写明实际像素。
 * 返回新元素 id 和像素尺寸
 */
export async function collageShots(
  engine: Engine,
  frameId: string,
  opts: { numbers: boolean },
): Promise<{ id: string; width: number; height: number }> {
  const frame = engine.doc.get(frameId)
  const shots = groupShots(engine.doc, frameId)
  const assetIds = shots.flatMap((el) => {
    const m = elementMedia(el)
    return m?.kind === 'image' ? [m.assetId] : []
  })
  if (assetIds.length < 2) throw new Error('至少要两张图才能拼')
  const group = shotGroupOf(frame)
  const cols = Math.min(assetIds.length, group?.cols ?? Math.ceil(Math.sqrt(assetIds.length)))
  const name = `${frame?.name ?? '分镜组'} · 拼图`
  const made = await api.mediaCollage({ assetIds, cols, numbers: opts.numbers, name })
  if (!engine.doc.get(frameId)) throw new Error('分镜组已经不在画布上了')
  // 画布上和分镜组一样宽，一眼能对上
  const fw = engine.doc.get(frameId)?.w ?? 960
  const size = { w: fw, h: Math.round((fw * made.height) / made.width) }
  let id = ''
  step(engine, () => {
    const spot = freeSpotRight(engine, frameId, size.w, size.h)
    id = createElement(engine.doc, {
      kind: 'image',
      assetId: made.asset.id,
      name: `${name} ${made.width}×${made.height}`,
      w: size.w,
      h: size.h,
      x: Math.round(spot.x),
      y: Math.round(spot.y),
    })
  })
  engine.selection.set([id])
  return { id, width: made.width, height: made.height }
}

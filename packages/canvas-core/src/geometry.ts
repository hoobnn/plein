import type { Rect } from '@plein/doc'

/** 纯几何工具：不依赖 Pixi / DOM，可在 Node 里测试 */

export function intersects(a: Rect, b: Rect) {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y
}

export function contains(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

export function containsPoint(r: Rect, x: number, y: number) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

export function union(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function expand(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 }
}

/** 两点围成的矩形（框选用） */
export function fromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

// ── 缩放 ──────────────────────────────────────────────

/** 八个缩放手柄：n/s/e/w 及四角 */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function handlePosition(r: Rect, h: Handle) {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2
  return { x, y }
}

export const HANDLE_CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
}

const MIN_SIZE = 8

/**
 * 拖动手柄后的新包围盒。keepAspect 时按对角线等比（边手柄按该边比例）。
 * 拖过对边时不翻转，夹在最小尺寸。
 */
export function resizeBox(box: Rect, h: Handle, dx: number, dy: number, keepAspect = false): Rect {
  let left = box.x
  let top = box.y
  let right = box.x + box.w
  let bottom = box.y + box.h
  if (h.includes('w')) left = Math.min(left + dx, right - MIN_SIZE)
  if (h.includes('e')) right = Math.max(right + dx, left + MIN_SIZE)
  if (h.includes('n')) top = Math.min(top + dy, bottom - MIN_SIZE)
  if (h.includes('s')) bottom = Math.max(bottom + dy, top + MIN_SIZE)

  if (keepAspect && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h
    let w = right - left
    let hh = bottom - top
    const horizontal = h === 'e' || h === 'w'
    const vertical = h === 'n' || h === 's'
    if (horizontal || (!vertical && w / box.w > hh / box.h)) hh = w / ratio
    else w = hh * ratio
    if (h.includes('w')) left = right - w
    else if (!h.includes('e')) left = box.x + (box.w - w) / 2
    right = left + w
    if (h.includes('n')) top = bottom - hh
    else if (!h.includes('s')) top = box.y + (box.h - hh) / 2
    bottom = top + hh
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 把一组矩形从旧包围盒线性映射到新包围盒 */
export function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const sx = from.w > 0 ? to.w / from.w : 1
  const sy = from.h > 0 ? to.h / from.h : 1
  return {
    x: to.x + (r.x - from.x) * sx,
    y: to.y + (r.y - from.y) * sy,
    w: Math.max(1, r.w * sx),
    h: Math.max(1, r.h * sy),
  }
}

// ── 吸附 ──────────────────────────────────────────────

export interface Guide {
  axis: 'x' | 'y'
  /** 参考线所在坐标 */
  at: number
  from: number
  to: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
}

const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w]
const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h]

/**
 * 移动吸附：把 moving 的左/中/右、上/中/下对齐到 targets 中最近的边或中线。
 * 返回需要额外施加的位移和要画出的参考线。
 */
export function snapMove(moving: Rect, targets: Iterable<Rect>, threshold: number): SnapResult {
  let bestX: { d: number; at: number } | null = null
  let bestY: { d: number; at: number } | null = null
  const list = [...targets]
  for (const t of list) {
    for (const a of xs(moving)) {
      for (const b of xs(t)) {
        const d = b - a
        if (Math.abs(d) <= threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d)))
          bestX = { d, at: b }
      }
    }
    for (const a of ys(moving)) {
      for (const b of ys(t)) {
        const d = b - a
        if (Math.abs(d) <= threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d)))
          bestY = { d, at: b }
      }
    }
  }
  const dx = bestX?.d ?? 0
  const dy = bestY?.d ?? 0
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: Guide[] = []
  const near = (v: number, w: number) => Math.abs(v - w) < 0.5
  if (bestX) {
    const at = bestX.at
    const hits = list.filter((t) => xs(t).some((v) => near(v, at)))
    const all = [snapped, ...hits]
    guides.push({
      axis: 'x',
      at,
      from: Math.min(...all.map((r) => r.y)),
      to: Math.max(...all.map((r) => r.y + r.h)),
    })
  }
  if (bestY) {
    const at = bestY.at
    const hits = list.filter((t) => ys(t).some((v) => near(v, at)))
    const all = [snapped, ...hits]
    guides.push({
      axis: 'y',
      at,
      from: Math.min(...all.map((r) => r.x)),
      to: Math.max(...all.map((r) => r.x + r.w)),
    })
  }
  return { dx, dy, guides }
}

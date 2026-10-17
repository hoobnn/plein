import type { Scene } from '@plein/canvas-core'
import type { Rect } from '@plein/doc'

/** 按遮挡矩形逐块扣除，保留互不相交的可见区域；重叠的遮挡不会相互抵消。 */
export function visibleRects(bounds: Rect, covers: Rect[]): Rect[] {
  let pieces = [bounds]
  for (const c of covers) {
    pieces = pieces.flatMap((r) => {
      const x = Math.max(r.x, c.x)
      const y = Math.max(r.y, c.y)
      const right = Math.min(r.x + r.w, c.x + c.w)
      const bottom = Math.min(r.y + r.h, c.y + c.h)
      if (x >= right || y >= bottom) return [r]
      return [
        { x: r.x, y: r.y, w: r.w, h: y - r.y },
        { x: r.x, y: bottom, w: r.w, h: r.y + r.h - bottom },
        { x: r.x, y, w: x - r.x, h: bottom - y },
        { x: right, y, w: r.x + r.w - right, h: bottom - y },
      ].filter((part) => part.w > 0 && part.h > 0)
    })
    if (!pieces.length) break
  }
  return pieces
}

/** DOM 正文和 GPU 底板共享绘制顺序，避免低层文字穿过高层图片、视频或节点。 */
export function clipOverlay(node: HTMLElement, scene: Scene, id: string, rect: Rect, title = 0) {
  const order = scene.drawOrder(id)
  node.style.zIndex = String(order)
  const bounds = { x: rect.x, y: rect.y - title, w: rect.w, h: rect.h + title }
  const covers = scene
    .query(bounds)
    .filter((other) => scene.drawOrder(other) > order && scene.get(other)?.kind !== 'frame')
    .map((other) => scene.rect(other)!)
  if (!covers.length) {
    node.style.clipPath = ''
    return
  }
  const path = visibleRects(bounds, covers)
    .map((r) => {
      const x = r.x - rect.x
      const y = r.y - rect.y
      return `M${x},${y}h${r.w}v${r.h}h${-r.w}Z`
    })
    .join(' ')
  node.style.clipPath = `path("${path || 'M0,0Z'}")`
}

import type { Rect } from '@plein/doc'

/** 画布顶部导航与底部工具条的屏幕留白。 */
const CHROME_EDGE = 64

/** 编辑窗口只占用节点落在画布安全视口内的部分，返回节点内的偏移。 */
export function editorViewport(
  rect: Rect,
  viewport: Rect,
  insets: { left: number; top: number; right: number; bottom: number },
  zoom: number,
): Rect | null {
  const x = Math.max(rect.x, viewport.x + insets.left / zoom)
  const y = Math.max(rect.y, viewport.y + Math.max(insets.top, CHROME_EDGE) / zoom)
  const right = Math.min(rect.x + rect.w, viewport.x + viewport.w - insets.right / zoom)
  const bottom = Math.min(
    rect.y + rect.h,
    viewport.y + viewport.h - Math.max(insets.bottom, CHROME_EDGE) / zoom,
  )
  if (right <= x || bottom <= y) return null
  return { x: x - rect.x, y: y - rect.y, w: right - x, h: bottom - y }
}

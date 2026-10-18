import type { Scene } from '@plein/canvas-core'
import type { Rect } from '@plein/doc'

const hiddenControls = new WeakMap<HTMLElement, Set<HTMLElement>>()

function restoreControls(node: HTMLElement) {
  for (const control of hiddenControls.get(node) ?? []) control.inert = false
  hiddenControls.delete(node)
}

function hideControl(node: HTMLElement, control: HTMLElement) {
  if (control.inert) return
  control.inert = true
  const controls = hiddenControls.get(node) ?? new Set<HTMLElement>()
  controls.add(control)
  hiddenControls.set(node, controls)
}

/** CSS 裁剪不改变 Tab 顺序；只撤下完全没有可见部分的交互区域。 */
function clipControls(node: HTMLElement, rect: Rect, visible: Rect[]) {
  restoreControls(node)
  if (node.matches(':fullscreen')) return
  if (!visible.length) return hideControl(node, node)
  const controls = node.querySelectorAll<HTMLElement>(
    'a[href], button, input, textarea, select, [tabindex]',
  )
  if (!controls.length) return
  const box = node.getBoundingClientRect()
  if (!box.width || !box.height) return
  const sx = rect.w / box.width
  const sy = rect.h / box.height
  for (const control of controls) {
    const shown = Array.from(control.getClientRects()).some((fragment) => {
      const x = rect.x + (fragment.left - box.left) * sx
      const y = rect.y + (fragment.top - box.top) * sy
      const right = x + fragment.width * sx
      const bottom = y + fragment.height * sy
      return visible.some((r) => x < r.x + r.w && right > r.x && y < r.y + r.h && bottom > r.y)
    })
    if (!shown) hideControl(node, control)
  }
}

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
    restoreControls(node)
    return
  }
  const visible = visibleRects(bounds, covers)
  const path = visible
    .map((r) => {
      const x = r.x - rect.x
      const y = r.y - rect.y
      return `M${x},${y}h${r.w}v${r.h}h${-r.w}Z`
    })
    .join(' ')
  node.style.clipPath = `path("${path || 'M0,0Z'}")`
  clipControls(node, rect, visible)
}

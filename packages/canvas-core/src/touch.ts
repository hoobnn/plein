import type { Camera } from './camera'

type Point = { x: number; y: number }

/** 抓手模式下的触屏导航；单指平移，双指按中心和距离同时平移／缩放。 */
export function attachTouchNavigation(
  el: HTMLElement,
  camera: Camera,
  options: { enabled(): boolean; begin(): void; move(write: () => void): void },
) {
  const points = new Map<number, Point>()
  const geometry = () => {
    const [first, second = first] = [...points.values()]
    return first
      ? {
          x: (first.x + second!.x) / 2,
          y: (first.y + second!.y) / 2,
          distance: Math.hypot(first.x - second!.x, first.y - second!.y),
        }
      : null
  }
  let previous: ReturnType<typeof geometry> = null
  const cancel = () => {
    const ids = [...points.keys()]
    points.clear()
    previous = null
    for (const id of ids) if (el.hasPointerCapture(id)) el.releasePointerCapture(id)
  }
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !options.enabled()) return
    if (!points.size) options.begin()
    event.preventDefault()
    points.set(event.pointerId, { x: event.clientX, y: event.clientY })
    previous = geometry()
    el.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent) => {
    if (!points.has(event.pointerId)) return
    event.preventDefault()
    points.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const next = geometry()!
    const old = previous!
    previous = next
    const rect = el.getBoundingClientRect()
    options.move(() => {
      camera.panBy(next.x - old.x, next.y - old.y)
      if (old.distance > 0 && next.distance > 0)
        camera.zoomAt(next.x - rect.left, next.y - rect.top, next.distance / old.distance)
    })
  }
  const up = (event: PointerEvent) => {
    if (!points.delete(event.pointerId)) return
    // 抬起一指后以剩余手指重新建基线，不沿用双指中心或启动旧单指惯性。
    previous = geometry()
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId)
  }
  const interrupted = (event: PointerEvent) => {
    if (points.has(event.pointerId)) cancel()
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', interrupted)
  el.addEventListener('lostpointercapture', interrupted)
  return {
    cancel,
    dispose() {
      cancel()
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', interrupted)
      el.removeEventListener('lostpointercapture', interrupted)
    },
  }
}

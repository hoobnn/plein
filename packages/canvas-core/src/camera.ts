/**
 * 相机：世界坐标 <-> 屏幕坐标。
 * 刻意不放进 React state —— 每帧直接驱动渲染层与 DOM 覆盖层。
 */
export class Camera {
  x = 0
  y = 0
  zoom = 1
  readonly minZoom = 0.05
  readonly maxZoom = 8

  private listeners = new Set<() => void>()

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  panBy(dx: number, dy: number) {
    this.x += dx
    this.y += dy
    this.emit()
  }

  /** 以屏幕上的某一点为中心缩放（光标不动） */
  zoomAt(sx: number, sy: number, factor: number) {
    const next = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor))
    const k = next / this.zoom
    this.x = sx - (sx - this.x) * k
    this.y = sy - (sy - this.y) * k
    this.zoom = next
    this.emit()
  }

  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom }
  }

  /** 给 DOM 覆盖层用的 CSS transform */
  get cssTransform() {
    return `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.zoom})`
  }
}

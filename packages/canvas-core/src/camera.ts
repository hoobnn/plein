import type { Rect } from '@plein/doc'

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
  /** 视口尺寸（屏幕像素），由引擎在 resize 时更新 */
  width = 0
  height = 0

  private listeners = new Set<() => void>()

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  setViewport(width: number, height: number) {
    this.width = width
    this.height = height
    this.emit()
  }

  panBy(dx: number, dy: number) {
    this.x += dx
    this.y += dy
    this.emit()
  }

  /** 以屏幕上的某一点为中心缩放（光标不动） */
  zoomAt(sx: number, sy: number, factor: number) {
    const next = this.clamp(this.zoom * factor)
    const k = next / this.zoom
    this.x = sx - (sx - this.x) * k
    this.y = sy - (sy - this.y) * k
    this.zoom = next
    this.emit()
  }

  /** 以视口中心缩放到指定倍数 */
  zoomTo(zoom: number) {
    this.zoomAt(this.width / 2, this.height / 2, zoom / this.zoom)
  }

  /** 让世界矩形完整落在视口内，留出 padding（屏幕像素） */
  fit(r: Rect, padding = 64, maxZoom = 1) {
    if (this.width === 0 || this.height === 0) return
    const zx = (this.width - padding * 2) / Math.max(r.w, 1)
    const zy = (this.height - padding * 2) / Math.max(r.h, 1)
    this.zoom = this.clamp(Math.min(zx, zy, maxZoom))
    this.x = this.width / 2 - (r.x + r.w / 2) * this.zoom
    this.y = this.height / 2 - (r.y + r.h / 2) * this.zoom
    this.emit()
  }

  /** 平移到让世界坐标 (wx, wy) 落在视口中央，缩放不变（小地图跳转） */
  centerOn(wx: number, wy: number) {
    this.x = this.width / 2 - wx * this.zoom
    this.y = this.height / 2 - wy * this.zoom
    this.emit()
  }

  screenToWorld(sx: number, sy: number) {
    return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom }
  }

  worldToScreen(wx: number, wy: number) {
    return { x: wx * this.zoom + this.x, y: wy * this.zoom + this.y }
  }

  /** 视口对应的世界矩形 */
  get viewRect(): Rect {
    const tl = this.screenToWorld(0, 0)
    return { x: tl.x, y: tl.y, w: this.width / this.zoom, h: this.height / this.zoom }
  }

  /** 给 DOM 覆盖层用的 CSS transform */
  get cssTransform() {
    return `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.zoom})`
  }

  private clamp(z: number) {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z))
  }
}

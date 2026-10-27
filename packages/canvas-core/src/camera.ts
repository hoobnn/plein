import type { Rect } from '@plein/doc'

/**
 * 相机：世界坐标 <-> 屏幕坐标。
 * 刻意不放进 React state —— 每帧直接驱动渲染层与 DOM 覆盖层。
 */
export class Camera {
  x = 0
  y = 0
  zoom = 1
  private minimumZoom = 0.05
  /** 普通缩放下限为 5%；适配大画布后允许回到该全景比例。 */
  get minZoom() {
    return this.minimumZoom
  }
  readonly maxZoom = 8
  /** 视口尺寸（屏幕像素），由引擎在 resize 时更新 */
  width = 0
  height = 0
  /** 被浮在画布上的面板（如侧栏）挡住的边距（屏幕像素）；适配与居中只用剩下的区域 */
  insets = { left: 0, top: 0, right: 0, bottom: 0 }

  private listeners = new Set<() => void>()
  private insetListeners = new Set<() => void>()

  onInsetsChange(fn: () => void) {
    this.insetListeners.add(fn)
    return () => {
      this.insetListeners.delete(fn)
    }
  }

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
    this.setZoomAt(sx, sy, this.zoom * factor)
  }

  private setZoomAt(sx: number, sy: number, zoom: number) {
    const next = this.clamp(zoom)
    const k = next / this.zoom
    this.x = sx - (sx - this.x) * k
    this.y = sy - (sy - this.y) * k
    this.zoom = next
    this.emit()
  }

  /** 以可见画布中心缩放，侧栏打开时不把当前内容推向挡板。 */
  zoomTo(zoom: number) {
    const { cx, cy } = this.safe
    this.setZoomAt(cx, cy, zoom)
  }

  /** 面板边距只通知布局订阅者，不移动相机或触发画面变化。 */
  setInsets(insets: Partial<Camera['insets']>) {
    const next = { ...this.insets, ...insets }
    if (
      next.left === this.insets.left &&
      next.top === this.insets.top &&
      next.right === this.insets.right &&
      next.bottom === this.insets.bottom
    )
      return
    this.insets = next
    for (const fn of this.insetListeners) fn()
  }

  /** 去掉挡住部分后的可见区域（屏幕像素） */
  private get safe() {
    const { left, top, right, bottom } = this.insets
    const w = Math.max(1, this.width - left - right)
    const h = Math.max(1, this.height - top - bottom)
    return { w, h, cx: left + w / 2, cy: top + h / 2 }
  }

  /** 让世界矩形完整落在可见区域内，留出 padding（屏幕像素） */
  fit(r: Rect, padding = 64, maxZoom = 1) {
    if (this.width === 0 || this.height === 0) return
    const to = this.fitTarget(r, padding, maxZoom)
    this.lookAt(to.x, to.y, to.zoom)
  }

  /** fit 的目标：可见区域中央对准的世界坐标和缩放（不改相机，用来做过渡动画） */
  fitTarget(r: Rect, padding = 64, maxZoom = 1) {
    const { w, h } = this.safe
    const zx = Math.max(1, w - padding * 2) / Math.max(r.w, 1)
    const zy = Math.max(1, h - padding * 2) / Math.max(r.h, 1)
    // 适配与定位动画必须能容纳整个目标，不能被普通滚轮的最小比例裁掉。
    const zoom = Math.min(zx, zy, maxZoom, this.maxZoom)
    return { x: r.x + r.w / 2, y: r.y + r.h / 2, zoom: zoom > 0 ? zoom : this.minZoom }
  }

  /** 可见区域中央对准的世界坐标 */
  get center() {
    const { cx, cy } = this.safe
    return this.screenToWorld(cx, cy)
  }

  /** 让世界坐标 (wx, wy) 落在可见区域中央，并设成指定缩放 */
  lookAt(wx: number, wy: number, zoom: number) {
    const { cx, cy } = this.safe
    // 程序定位可以扩展缩小范围；后续滚轮和动画也沿用这个下限，避免突然跳回 5%。
    if (Number.isFinite(zoom) && zoom > 0) this.minimumZoom = Math.min(this.minimumZoom, zoom)
    this.zoom = this.clamp(zoom)
    this.x = cx - wx * this.zoom
    this.y = cy - wy * this.zoom
    this.emit()
  }

  /** 平移到让世界坐标 (wx, wy) 落在可见区域中央，缩放不变（小地图跳转） */
  centerOn(wx: number, wy: number) {
    const { cx, cy } = this.safe
    this.x = cx - wx * this.zoom
    this.y = cy - wy * this.zoom
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

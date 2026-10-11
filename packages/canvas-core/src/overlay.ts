import type { Rect } from '@plein/doc'
import { Graphics } from 'pixi.js'
import type { Camera } from './camera'
import { type Guide, HANDLES, handlePosition, union } from './geometry'
import type { Scene } from './scene'
import type { Selection } from './selection'

const ACCENT = 0x7cc4ff
const GUIDE = 0xff6b8a
/** 手柄边长（屏幕像素） */
export const HANDLE_PX = 8

/**
 * 选择叠加层：选中描边、包围盒与缩放手柄、框选矩形、吸附参考线。
 * 线宽和手柄大小按缩放反算，屏幕上保持恒定。
 */
export class SelectionOverlay {
  readonly graphics = new Graphics()
  private marquee: Rect | null = null
  private guides: Guide[] = []
  private dirty = true

  constructor(
    private scene: Scene,
    private selection: Selection,
    private camera: Camera,
  ) {
    this.graphics.zIndex = 2
  }

  markDirty() {
    this.dirty = true
  }

  setMarquee(r: Rect | null) {
    this.marquee = r
    this.dirty = true
  }

  setGuides(g: Guide[]) {
    if (g.length === 0 && this.guides.length === 0) return
    this.guides = g
    this.dirty = true
  }

  /** 选中元素的世界包围盒 */
  selectionBox(): Rect | null {
    return union(
      this.selection
        .values()
        .map((id) => this.scene.rect(id))
        .filter((r): r is Rect => !!r),
    )
  }

  update() {
    if (!this.dirty) return
    this.dirty = false
    const px = 1 / this.camera.zoom
    const g = this.graphics.clear()

    const ids = this.selection.values()
    for (const id of ids) {
      const r = this.scene.rect(id)
      if (r) g.rect(r.x, r.y, r.w, r.h)
    }
    if (ids.length > 0) g.stroke({ color: ACCENT, width: 1.5 * px })

    const box = this.selectionBox()
    if (box && this.showHandles()) {
      if (ids.length > 1)
        g.rect(box.x, box.y, box.w, box.h).stroke({ color: ACCENT, alpha: 0.6, width: px })
      const s = HANDLE_PX * px
      for (const h of HANDLES) {
        const p = handlePosition(box, h)
        g.rect(p.x - s / 2, p.y - s / 2, s, s)
      }
      g.fill({ color: 0x0e0e10 }).stroke({ color: ACCENT, width: 1.5 * px })
    }

    if (this.marquee) {
      const m = this.marquee
      g.rect(m.x, m.y, m.w, m.h)
        .fill({ color: ACCENT, alpha: 0.08 })
        .stroke({ color: ACCENT, alpha: 0.8, width: px })
    }

    for (const guide of this.guides) {
      if (guide.axis === 'x') g.moveTo(guide.at, guide.from).lineTo(guide.at, guide.to)
      else g.moveTo(guide.from, guide.at).lineTo(guide.to, guide.at)
    }
    if (this.guides.length > 0) g.stroke({ color: GUIDE, width: px })
  }

  /** 选中项全部锁定时不显示手柄 */
  showHandles() {
    return this.selection.values().some((id) => this.scene.get(id)?.locked === false)
  }

  destroy() {
    this.graphics.destroy()
  }
}

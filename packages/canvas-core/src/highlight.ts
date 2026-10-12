import { Graphics } from 'pixi.js'
import type { Camera } from './camera'
import type { Scene } from './scene'
import { theme } from './theme'

/** 一次高亮持续多久（毫秒） */
const DURATION = 1600
/** 通知先到、元素还没同步过来时最多等多久 */
const WAIT = 3000
/** 淡入时长 */
const FADE_IN = 140

const easeOut = (t: number) => 1 - (1 - t) ** 3

/** 系统要求减少动态效果时只淡出、不扩散 */
const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 改动高亮：别人（智能体、协作者）刚改过的元素描一圈强调色光晕，
 * 向外扩散并淡出。线宽按缩放反算，屏幕上保持恒定；没有高亮时不占帧。
 */
export class HighlightLayer {
  readonly graphics = new Graphics()
  /** id → 开始时刻；元素还没同步到场景时为 null，等它出现再开始（最多等 WAIT 毫秒） */
  private active = new Map<string, { start: number | null; at: number }>()
  private drawn = false

  constructor(
    private scene: Scene,
    private camera: Camera,
  ) {
    // 在元素之上、选择叠加层之下
    this.graphics.zIndex = 1.5
  }

  flash(ids: Iterable<string>, now = performance.now()) {
    for (const id of ids) this.active.set(id, { start: null, at: now })
  }

  /** 每帧调用；返回是否改了图形 */
  update(now = performance.now()): boolean {
    if (this.active.size === 0) {
      if (!this.drawn) return false
      this.graphics.clear()
      this.drawn = false
      return true
    }
    const px = 1 / this.camera.zoom
    const g = this.graphics.clear()
    for (const [id, h] of this.active) {
      const r = this.scene.rect(id)
      // 改动经文档同步过来可能比通知晚一点
      if (!r) {
        if (h.start !== null || now - h.at > WAIT) this.active.delete(id)
        continue
      }
      h.start ??= now
      const elapsed = now - h.start
      if (elapsed >= DURATION) {
        this.active.delete(id)
        continue
      }
      const t = elapsed / DURATION
      const alpha = (1 - t) ** 2 * Math.min(1, elapsed / FADE_IN)
      const grow = (3 + (reducedMotion() ? 0 : 12 * easeOut(t))) * px
      const radius = this.scene.get(id)?.kind === 'frame' ? 20 : 16
      g.roundRect(r.x, r.y, r.w, r.h, radius).fill({ color: theme.accent, alpha: 0.07 * alpha })
      g.roundRect(r.x - grow, r.y - grow, r.w + grow * 2, r.h + grow * 2, radius + grow).stroke({
        color: theme.accent,
        alpha: 0.9 * alpha,
        width: 2 * px,
      })
    }
    this.drawn = true
    return true
  }

  destroy() {
    this.graphics.destroy()
  }
}

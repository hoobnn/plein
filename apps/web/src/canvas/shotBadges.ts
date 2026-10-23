import type { Engine } from '@plein/canvas-core'
import { groupShots, shotGroupOf } from '@plein/doc'
import { clipOverlay } from './occlusion'

/** 序号角标离图片左上角的距离（世界坐标） */
const INSET = 8

/**
 * 分镜组的序号角标：组里每张图左上角一个编号，跟着相机缩放（和节点标题一样在世界坐标里）。
 * 只给视口里的图片建 DOM，低细节时全部隐藏。
 */
export class ShotBadges {
  private badges = new Map<string, HTMLSpanElement>()
  /** 视口和几何预览不改变编号；文档内容刷新后再按需推导。 */
  private orders = new Map<string, Map<string, number>>()
  private off: Array<() => void> = []

  constructor(
    private engine: Engine,
    private root: HTMLElement,
  ) {
    this.off.push(
      engine.onViewChange(({ content }) => {
        if (content) this.orders.clear()
        this.sync()
      }),
    )
    this.sync()
  }

  sync() {
    const { engine } = this
    const want = new Map<string, number>()
    if (engine.highDetail) {
      for (const id of engine.visibleIds) {
        const parent = engine.scene.get(id)?.parentId
        if (!parent) continue
        let order = this.orders.get(parent)
        if (!order) {
          order = shotGroupOf(engine.doc.get(parent))
            ? new Map(groupShots(engine.doc, parent).map((el, i) => [el.id, i + 1]))
            : new Map()
          this.orders.set(parent, order)
        }
        const n = order.get(id)
        if (n) want.set(id, n)
      }
    }
    for (const [id, node] of this.badges) {
      if (want.has(id)) continue
      node.remove()
      this.badges.delete(id)
    }
    for (const [id, n] of want) {
      const rect = engine.scene.rect(id)
      if (!rect) continue
      let node = this.badges.get(id)
      if (!node) {
        node = document.createElement('span')
        node.className = 'plein-shot-badge'
        node.dataset.shotBadge = id
        this.root.appendChild(node)
        this.badges.set(id, node)
      }
      const text = String(n)
      if (node.textContent !== text) node.textContent = text
      node.style.transform = `translate(${rect.x + INSET}px, ${rect.y + INSET}px)`
      clipOverlay(node, engine.scene, id, {
        x: rect.x + INSET,
        y: rect.y + INSET,
        w: node.offsetWidth,
        h: node.offsetHeight,
      })
    }
  }

  destroy() {
    for (const off of this.off) off()
    for (const node of this.badges.values()) node.remove()
    this.badges.clear()
    this.orders.clear()
  }
}

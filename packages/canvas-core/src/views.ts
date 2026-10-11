import type { Rect } from '@plein/doc'
import { Container } from 'pixi.js'
import type { ElementView, RenderContext, RendererRegistry } from './renderers'
import type { Scene, SceneUpdate } from './scene'

interface ViewNode {
  /** 按局部坐标定位，子元素挂在 kids 里随之移动 */
  root: Container
  kids: Container
  /** 元素自身的显示对象，首次进入视口时才创建 */
  body: ElementView | null
  inView: boolean
}

/** 视口外多渲染一圈（世界坐标会按缩放换算），平移时不闪 */
const CULL_MARGIN_PX = 200
/** 低于这个缩放只画色块，不画文字等细节 */
const DETAIL_ZOOM = 0.3

/**
 * 元素显示树：容器嵌套与文档父子关系一致，同级按 z 排序。
 * 只有视口内的元素才创建并显示渲染内容。
 */
export class ElementViews {
  readonly layer = new Container({ sortableChildren: true })
  private nodes = new Map<string, ViewNode>()
  private visible = new Set<string>()
  private highDetail = true

  constructor(
    private scene: Scene,
    private registry: RendererRegistry,
    private ctx: RenderContext,
  ) {}

  /** 应用场景变更：增删节点、更新内容与位置、必要时重挂载排序 */
  sync(update: SceneUpdate) {
    for (const id of update.removed) this.remove(id)
    for (const id of update.changed) {
      if (!this.nodes.has(id)) this.nodes.set(id, this.createNode())
    }
    if (update.structure) this.restructure()
    this.refresh(update.changed)
  }

  /** 重新定位并重画（几何或内容变化后） */
  refresh(ids: Iterable<string>) {
    for (const id of ids) {
      const node = this.nodes.get(id)
      const local = this.scene.localRect(id)
      const el = this.scene.get(id)
      if (!node || !local || !el) continue
      node.root.position.set(local.x, local.y)
      node.body?.update({ ...el, ...local })
    }
  }

  /** 视口裁剪：只对进出视口的元素做增量切换 */
  cull(view: Rect, zoom: number) {
    const high = zoom >= DETAIL_ZOOM
    if (high !== this.highDetail) {
      this.highDetail = high
      for (const n of this.nodes.values()) n.body?.setDetail?.(high)
    }
    const m = CULL_MARGIN_PX / zoom
    const next = new Set(
      this.scene.query({ x: view.x - m, y: view.y - m, w: view.w + m * 2, h: view.h + m * 2 }),
    )
    for (const id of this.visible) if (!next.has(id)) this.setInView(id, false)
    for (const id of next) if (!this.visible.has(id)) this.setInView(id, true)
    this.visible = next
  }

  get visibleCount() {
    return this.visible.size
  }

  destroy() {
    for (const n of this.nodes.values()) n.body?.destroy()
    this.layer.destroy({ children: true })
    this.nodes.clear()
  }

  private createNode(): ViewNode {
    const root = new Container()
    const kids = new Container({ sortableChildren: true })
    root.addChild(kids)
    root.visible = false
    return { root, kids, body: null, inView: false }
  }

  private setInView(id: string, inView: boolean) {
    const node = this.nodes.get(id)
    if (!node) return
    node.inView = inView
    if (inView && !node.body) {
      const el = this.scene.get(id)
      const local = this.scene.localRect(id)
      if (el && local) {
        node.body = this.registry.create({ ...el, ...local }, this.ctx)
        node.body.setDetail?.(this.highDetail)
        node.root.addChildAt(node.body.display, 0)
      }
    }
    if (node.body) node.body.display.visible = inView
    this.updateVisibility(node)
  }

  /** 叶子元素出视口时整个容器隐藏；有子元素的容器保留，子元素各自裁剪 */
  private updateVisibility(node: ViewNode) {
    node.root.visible = node.inView || node.kids.children.length > 0
  }

  private restructure() {
    const visit = (parent: string | null, container: Container) => {
      this.scene.children(parent).forEach((id, i) => {
        const node = this.nodes.get(id)
        if (!node) return
        if (node.root.parent !== container) container.addChild(node.root)
        node.root.zIndex = i
        visit(id, node.kids)
      })
    }
    visit(null, this.layer)
    for (const node of this.nodes.values()) this.updateVisibility(node)
  }

  private remove(id: string) {
    const node = this.nodes.get(id)
    if (!node) return
    // 子容器若仍挂着别的元素，restructure 会把它们移走；这里先摘下再销毁
    for (const child of [...node.kids.children]) this.layer.addChild(child)
    node.body?.destroy()
    node.root.destroy({ children: true })
    this.nodes.delete(id)
    this.visible.delete(id)
  }
}

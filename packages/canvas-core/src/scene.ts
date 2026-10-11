import { type CanvasElement, compareZ, type DocChange, type PleinDoc, type Rect } from '@plein/doc'
import RBush from 'rbush'
import { containsPoint } from './geometry'

interface Item {
  minX: number
  minY: number
  maxX: number
  maxY: number
  id: string
}

/** 交互预览期间覆盖在元素上的局部几何（松手前不写文档） */
export type Transient = Partial<Rect>

/** 一次同步后需要渲染层处理的内容 */
export interface SceneUpdate {
  /** 内容或几何变化、需要重画的元素 */
  changed: Set<string>
  removed: Set<string>
  /** 父子关系或 z 序变化，需要重新挂载与排序 */
  structure: boolean
}

/**
 * 场景索引：从文档维护世界坐标、父子关系、绘制顺序与 R-tree。
 * 不依赖 Pixi，可单独测试；渲染层和交互层都从这里读。
 */
export class Scene {
  private rects = new Map<string, Rect>()
  private items = new Map<string, Item>()
  private tree = new RBush<Item>()
  private parentOf = new Map<string, string | null>()
  private zOf = new Map<string, string>()
  private childIds = new Map<string | null, Set<string>>([[null, new Set()]])
  private transient = new Map<string, Transient>()
  private orderDirty = true
  private order = new Map<string, number>()
  private sorted = new Map<string | null, string[]>()

  constructor(readonly doc: PleinDoc) {
    this.rebuild()
  }

  /** 全量重建（初始化或迁移后） */
  rebuild(): SceneUpdate {
    const removed = new Set(this.rects.keys())
    this.rects.clear()
    this.items.clear()
    this.parentOf.clear()
    this.zOf.clear()
    this.childIds = new Map([[null, new Set()]])
    const els = [...this.doc.elements()]
    for (const el of els) {
      removed.delete(el.id)
      this.link(el.id, this.doc.effectiveParent(el))
      this.zOf.set(el.id, el.z)
    }
    for (const el of els) this.computeRect(el.id)
    this.tree.clear()
    this.tree.load([...this.items.values()])
    this.orderDirty = true
    return { changed: new Set(els.map((e) => e.id)), removed, structure: true }
  }

  /** 应用一批文档变更：几何变化级联到后代 */
  apply(change: DocChange): SceneUpdate {
    const update: SceneUpdate = { changed: new Set(), removed: new Set(), structure: false }
    const geometry = new Set<string>()
    const queue = [...change.elements]
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!
      const el = this.doc.get(id)
      if (!el) {
        if (!this.parentOf.has(id)) continue
        // 子元素可能因父元素消失而变成根，重新评估
        for (const c of this.childIds.get(id) ?? []) queue.push(c)
        this.unlink(id)
        this.removeItem(id)
        this.rects.delete(id)
        this.zOf.delete(id)
        this.transient.delete(id)
        update.removed.add(id)
        update.structure = true
        continue
      }
      const parent = this.doc.effectiveParent(el)
      if (!this.parentOf.has(id) || this.parentOf.get(id) !== parent) {
        this.unlink(id)
        this.link(id, parent)
        update.structure = true
      }
      if (this.zOf.get(id) !== el.z) {
        this.zOf.set(id, el.z)
        this.orderDirty = true
        update.structure = true
      }
      update.changed.add(id)
      geometry.add(id)
    }
    for (const id of geometry) this.refreshSubtree(id)
    return update
  }

  // ── 读取 ────────────────────────────────────────────

  has(id: string) {
    return this.rects.has(id)
  }

  get(id: string): CanvasElement | undefined {
    return this.doc.get(id)
  }

  /** 世界坐标矩形（含交互预览） */
  rect(id: string): Rect | undefined {
    return this.rects.get(id)
  }

  /** 局部几何（含交互预览），渲染层定位子容器用 */
  localRect(id: string): Rect | undefined {
    const el = this.doc.get(id)
    if (!el) return undefined
    const t = this.transient.get(id)
    return { x: t?.x ?? el.x, y: t?.y ?? el.y, w: t?.w ?? el.w, h: t?.h ?? el.h }
  }

  parent(id: string): string | null {
    return this.parentOf.get(id) ?? null
  }

  /** 同级子元素，按绘制顺序 */
  children(parentId: string | null): readonly string[] {
    this.ensureOrder()
    return this.sorted.get(parentId) ?? []
  }

  /** 全局绘制顺序，越大越靠上 */
  drawOrder(id: string): number {
    this.ensureOrder()
    return this.order.get(id) ?? -1
  }

  isAncestor(ancestor: string, id: string) {
    let p = this.parentOf.get(id) ?? null
    while (p !== null) {
      if (p === ancestor) return true
      p = this.parentOf.get(p) ?? null
    }
    return false
  }

  /** 与矩形相交的元素 id */
  query(r: Rect): string[] {
    return this.tree
      .search({ minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h })
      .map((i) => i.id)
  }

  /** 世界坐标下最上层的元素 */
  hitTest(x: number, y: number, filter?: (id: string) => boolean): string | null {
    let best: string | null = null
    let bestOrder = -1
    for (const id of this.query({ x, y, w: 0, h: 0 })) {
      if (filter && !filter(id)) continue
      const r = this.rects.get(id)!
      if (!containsPoint(r, x, y)) continue
      const o = this.drawOrder(id)
      if (o > bestOrder) {
        best = id
        bestOrder = o
      }
    }
    return best
  }

  get size() {
    return this.rects.size
  }

  ids() {
    return this.rects.keys()
  }

  // ── 交互预览 ────────────────────────────────────────

  /** 设置预览几何（局部坐标），返回需要重画的元素 */
  setTransient(patches: Map<string, Transient>): Set<string> {
    const touched = new Set([...this.transient.keys(), ...patches.keys()])
    this.transient = new Map([...patches].filter(([id]) => this.rects.has(id)))
    for (const id of touched) if (this.rects.has(id)) this.refreshSubtree(id)
    return touched
  }

  clearTransient(): Set<string> {
    return this.setTransient(new Map())
  }

  hasTransient() {
    return this.transient.size > 0
  }

  // ── 内部 ────────────────────────────────────────────

  private link(id: string, parent: string | null) {
    this.parentOf.set(id, parent)
    let set = this.childIds.get(parent)
    if (!set) {
      set = new Set()
      this.childIds.set(parent, set)
    }
    set.add(id)
    this.orderDirty = true
  }

  private unlink(id: string) {
    if (!this.parentOf.has(id)) return
    this.childIds.get(this.parentOf.get(id) ?? null)?.delete(id)
    this.parentOf.delete(id)
    this.orderDirty = true
  }

  private computeRect(id: string): Rect | undefined {
    const local = this.localRect(id)
    if (!local) return undefined
    const p = this.parentOf.get(id) ?? null
    const origin = p === null ? null : (this.rects.get(p) ?? this.computeRect(p))
    const r = {
      x: local.x + (origin?.x ?? 0),
      y: local.y + (origin?.y ?? 0),
      w: local.w,
      h: local.h,
    }
    this.rects.set(id, r)
    this.items.set(id, { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h, id })
    return r
  }

  private refreshSubtree(id: string) {
    const stack = [id]
    while (stack.length > 0) {
      const cur = stack.pop()!
      this.removeItem(cur)
      if (!this.computeRect(cur)) continue
      this.tree.insert(this.items.get(cur)!)
      for (const c of this.childIds.get(cur) ?? []) stack.push(c)
    }
  }

  private removeItem(id: string) {
    const item = this.items.get(id)
    if (!item) return
    this.tree.remove(item)
    this.items.delete(id)
  }

  private ensureOrder() {
    if (!this.orderDirty) return
    this.orderDirty = false
    this.order.clear()
    this.sorted.clear()
    let n = 0
    const visit = (parent: string | null) => {
      const els = [...(this.childIds.get(parent) ?? [])]
        .map((id) => this.doc.get(id))
        .filter((e): e is CanvasElement => !!e)
        .sort(compareZ)
      const ids = els.map((e) => e.id)
      this.sorted.set(parent, ids)
      for (const id of ids) {
        this.order.set(id, n++)
        visit(id)
      }
    }
    visit(null)
  }
}

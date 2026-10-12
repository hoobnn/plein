import * as Y from 'yjs'
import { migrate } from './migrate'
import {
  type CanvasElement,
  type DocChange,
  CONTAINER_KINDS,
  ELEMENT_KINDS,
  type Edge,
  type ElementKind,
  type NodeResult,
  type NodeRun,
  type Ports,
  type Rect,
} from './types'

/** 用户命令的事务 origin；UndoManager 只追踪它 */
export const LOCAL_ORIGIN = Symbol('plein:local')
/** 迁移等系统写入的 origin，不进撤销栈 */
export const SYSTEM_ORIGIN = Symbol('plein:system')

export type ElementMap = Y.Map<unknown>

/** 变更通知的调度器：默认按动画帧归并，测试里可换成手动 flush */
export type Scheduler = (flush: () => void) => void

export interface DocOptions {
  schedule?: Scheduler
  /** 连续修改合并为一步撤销的时间窗（毫秒） */
  captureTimeout?: number
  /** 写命令的事务 origin，默认 LOCAL_ORIGIN；服务端替智能体写入时传会话自己的 origin */
  origin?: unknown
}

type Listener = (change: DocChange) => void

const defaultSchedule: Scheduler = (flush) => {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number }
  // 必须以 globalThis 调用，解构出来单独调用会抛 Illegal invocation
  if (g.requestAnimationFrame) g.requestAnimationFrame(flush)
  else void Promise.resolve().then(flush)
}

const isKind = (v: unknown): v is ElementKind => ELEMENT_KINDS.includes(v as ElementKind)
const num = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** 同级排序：z 升序，相同时按 id（并发生成相同 z 时保证各端一致） */
export function compareZ(a: CanvasElement, b: CanvasElement) {
  if (a.z !== b.z) return a.z < b.z ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * plein 文档：Yjs 是唯一事实来源，这里提供只读快照、变更订阅与撤销。
 * 写入一律走 commands.ts 里的命令。
 */
export class PleinDoc {
  readonly ydoc: Y.Doc
  readonly meta: Y.Map<unknown>
  readonly elementMaps: Y.Map<ElementMap>
  readonly edgeMap: Y.Map<Edge>
  readonly undo: Y.UndoManager
  /** 写命令的事务 origin（见 DocOptions.origin） */
  readonly origin: unknown
  /** 文档版本高于本客户端时只读打开 */
  readOnly = false
  schemaVersion = 0

  private cache = new Map<string, CanvasElement>()
  private listeners = new Set<Listener>()
  private pendingElements = new Set<string>()
  private pendingEdges = new Set<string>()
  private scheduled = false
  private schedule: Scheduler
  private disposers: Array<() => void> = []

  constructor(ydoc = new Y.Doc(), opts: DocOptions = {}) {
    this.ydoc = ydoc
    this.schedule = opts.schedule ?? defaultSchedule
    this.origin = opts.origin ?? LOCAL_ORIGIN
    this.meta = ydoc.getMap('meta')
    this.elementMaps = ydoc.getMap('elements')
    this.edgeMap = ydoc.getMap('edges')
    this.undo = new Y.UndoManager([this.elementMaps, this.edgeMap], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: opts.captureTimeout ?? 300,
    })

    const onElements = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
      for (const ev of events) {
        if (ev.target === this.elementMaps) {
          for (const key of ev.changes.keys.keys()) this.touchElement(key)
        } else {
          const id = ev.path[0]
          if (typeof id === 'string') this.touchElement(id)
        }
      }
      this.requestFlush()
    }
    const onEdges = (ev: Y.YMapEvent<Edge>) => {
      for (const key of ev.keysChanged) this.pendingEdges.add(key)
      this.requestFlush()
    }
    this.elementMaps.observeDeep(onElements)
    this.edgeMap.observe(onEdges)
    this.disposers.push(
      () => this.elementMaps.unobserveDeep(onElements),
      () => this.edgeMap.unobserve(onEdges),
    )

    this.migrate()
  }

  /** 执行 schema 迁移；初次同步完成后应再调用一次 */
  migrate() {
    const r = migrate(this.ydoc, SYSTEM_ORIGIN)
    this.schemaVersion = r.version
    this.readOnly = r.readOnly
    this.cache.clear()
  }

  // ── 读取 ────────────────────────────────────────────

  get size() {
    return this.elementMaps.size
  }

  has(id: string) {
    return this.get(id) !== undefined
  }

  get(id: string): CanvasElement | undefined {
    const cached = this.cache.get(id)
    if (cached && this.elementMaps.has(id)) return cached
    const m = this.elementMaps.get(id)
    if (!(m instanceof Y.Map)) return undefined
    const el = readElement(id, m)
    if (el) this.cache.set(id, el)
    return el
  }

  *elements(): IterableIterator<CanvasElement> {
    for (const id of this.elementMaps.keys()) {
      const el = this.get(id)
      if (el) yield el
    }
  }

  /** 某个父元素（null 为根）下的子元素，按绘制顺序 */
  children(parentId: string | null): CanvasElement[] {
    const out: CanvasElement[] = []
    for (const el of this.elements()) {
      if (this.effectiveParent(el) === parentId) out.push(el)
    }
    return out.sort(compareZ)
  }

  /** 所有后代（不含自身），深度优先 */
  descendants(id: string): CanvasElement[] {
    const byParent = new Map<string, CanvasElement[]>()
    for (const el of this.elements()) {
      const p = this.effectiveParent(el)
      if (p === null) continue
      const list = byParent.get(p)
      if (list) list.push(el)
      else byParent.set(p, [el])
    }
    const out: CanvasElement[] = []
    const visit = (pid: string) => {
      for (const c of byParent.get(pid) ?? []) {
        out.push(c)
        visit(c.id)
      }
    }
    visit(id)
    return out
  }

  /**
   * 生效的父元素：父元素不存在、不是容器或成环（并发 setParent 可能造成）时视为根。
   */
  effectiveParent(el: CanvasElement): string | null {
    const pid = el.parentId
    if (pid === null) return null
    const parent = this.get(pid)
    if (!parent || !CONTAINER_KINDS.has(parent.kind)) return null
    // 向上走一遍：链上任何重复都说明成环，环上及挂在环下的元素都按根处理
    const seen = new Set([el.id])
    let cur: string | null = pid
    while (cur !== null) {
      if (seen.has(cur)) return null
      seen.add(cur)
      cur = this.get(cur)?.parentId ?? null
    }
    return pid
  }

  /** 祖先链（由近及远），已处理悬空与成环 */
  ancestors(id: string): CanvasElement[] {
    const out: CanvasElement[] = []
    const el = this.get(id)
    if (!el) return out
    let pid = this.effectiveParent(el)
    while (pid !== null) {
      const p = this.get(pid)
      if (!p) break
      out.push(p)
      pid = this.effectiveParent(p)
    }
    return out
  }

  /** 世界坐标下的矩形 */
  worldRect(id: string): Rect | undefined {
    const el = this.get(id)
    if (!el) return undefined
    let { x, y } = el
    for (const a of this.ancestors(id)) {
      x += a.x
      y += a.y
    }
    return { x, y, w: el.w, h: el.h }
  }

  getEdge(id: string): Edge | undefined {
    const e = this.edgeMap.get(id)
    return e && this.has(e.from[0]) && this.has(e.to[0]) ? e : undefined
  }

  /** 两端元素都存在的边；并发删除留下的悬空边在读取时忽略 */
  *edges(): IterableIterator<Edge> {
    for (const e of this.edgeMap.values()) {
      if (this.has(e.from[0]) && this.has(e.to[0])) yield e
    }
  }

  edgesOf(elementId: string): Edge[] {
    return [...this.edges()].filter((e) => e.from[0] === elementId || e.to[0] === elementId)
  }

  /** 给编辑器绑定用的 Y.Text */
  getText(id: string): Y.Text | undefined {
    const t = this.elementMaps.get(id)?.get('text')
    return t instanceof Y.Text ? t : undefined
  }

  /** 命令写入前取出元素的 Y.Map，同时让快照缓存失效（事务内后续读取不会读到旧值） */
  mutable(id: string): ElementMap | undefined {
    const m = this.elementMaps.get(id)
    if (!(m instanceof Y.Map)) return undefined
    this.cache.delete(id)
    return m
  }

  // ── 订阅 ────────────────────────────────────────────

  /** 订阅按帧归并的变更 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 立即派发尚未通知的变更 */
  flush() {
    this.scheduled = false
    if (this.pendingElements.size === 0 && this.pendingEdges.size === 0) return
    const change: DocChange = { elements: this.pendingElements, edges: this.pendingEdges }
    this.pendingElements = new Set()
    this.pendingEdges = new Set()
    for (const fn of this.listeners) fn(change)
  }

  destroy() {
    this.disposers.forEach((d) => {
      d()
    })
    this.undo.destroy()
    this.listeners.clear()
  }

  private touchElement(id: string) {
    this.cache.delete(id)
    this.pendingElements.add(id)
  }

  private requestFlush() {
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => this.flush())
  }
}

function isResult(r: unknown): r is NodeResult {
  const v = r as NodeResult | null
  return !!v && typeof v.id === 'string' && typeof v.port === 'string' && !!v.value
}

function readElement(id: string, m: ElementMap): CanvasElement | undefined {
  const kind = m.get('kind')
  if (!isKind(kind)) return undefined
  const el: CanvasElement = {
    id,
    kind,
    x: num(m.get('x')),
    y: num(m.get('y')),
    w: num(m.get('w'), 1),
    h: num(m.get('h'), 1),
    rotation: num(m.get('rotation')),
    z: str(m.get('z')) ?? '',
    parentId: str(m.get('parentId')) ?? null,
    locked: m.get('locked') === true,
  }
  const name = str(m.get('name'))
  if (name !== undefined) el.name = name
  const color = str(m.get('color'))
  if (color !== undefined) el.color = color
  const assetId = str(m.get('assetId'))
  if (assetId !== undefined) el.assetId = assetId
  const text = m.get('text')
  if (text instanceof Y.Text) el.text = text.toString()
  const params = m.get('params')
  if (params instanceof Y.Map) el.params = params.toJSON()
  const ports = m.get('ports') as Ports | undefined
  if (ports && Array.isArray(ports.inputs) && Array.isArray(ports.outputs)) el.ports = ports
  const nodeType = str(m.get('nodeType'))
  if (nodeType !== undefined) el.nodeType = nodeType
  const nodeVersion = m.get('nodeVersion')
  if (typeof nodeVersion === 'number') el.nodeVersion = nodeVersion
  const results = m.get('results')
  if (Array.isArray(results)) el.results = results.filter(isResult)
  const adopted = str(m.get('adopted'))
  if (adopted !== undefined) el.adopted = adopted
  const run = m.get('run') as NodeRun | undefined
  if (run && typeof run === 'object' && typeof run.status === 'string') el.run = run
  return el
}

/** 打开（或新建）一个 plein 文档并完成迁移 */
export function createDoc(ydoc?: Y.Doc, opts?: DocOptions) {
  return new PleinDoc(ydoc, opts)
}

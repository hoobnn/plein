import { topLevel, updateElements } from './commands'
import type { PleinDoc } from './doc'
import type { CanvasElement, ElementPatch, Rect } from './types'

/**
 * 整理画布：按连线拓扑自动布局。
 * 上游在左、下游在右（最长路径分层），同层纵向排开（重心法减少交叉）；
 * 有连线的一组占一行，孤立元素按原阅读顺序排在后面。Frame 内的元素在 Frame 内整理，Frame 随之收放。
 */

export interface LayoutItem {
  id: string
  /** 原位置：决定同层初始顺序和孤立元素的先后 */
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutOptions {
  /** 相邻两层的水平间距 */
  gapX?: number
  /** 同层元素的垂直间距 */
  gapY?: number
  /** 组与组、行与行之间的间距 */
  gap?: number
  /** 孤立元素一行最多排多宽（不小于最宽的一组） */
  rowWidth?: number
}

const DEFAULTS = { gapX: 96, gapY: 56, gap: 96, rowWidth: 1600 }

/** 阅读顺序：先上后下，同一行先左后右 */
const reading = (a: LayoutItem, b: LayoutItem) => a.y - b.y || a.x - b.x

/**
 * 纯布局：返回每个元素的新左上角，整体包围盒的左上角在 (0, 0)。
 * links 是 [上游, 下游]，不认识的 id、自连和重复连线会被忽略；连线成环时按原顺序断开回边。
 */
export function layoutGraph(
  items: LayoutItem[],
  links: Array<[string, string]>,
  opts: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const { gapX, gapY, gap, rowWidth } = { ...DEFAULTS, ...opts }
  const byId = new Map(items.map((it) => [it.id, it]))
  const order = [...items].sort(reading)
  const rank = new Map(order.map((it, i) => [it.id, i]))

  const out = new Map<string, Set<string>>(items.map((it) => [it.id, new Set()]))
  for (const [a, b] of links) {
    if (a === b || !byId.has(a) || !byId.has(b)) continue
    out.get(a)!.add(b)
  }

  // 弱连通分量（并查集），按分量里最靠前的元素排序
  const root = new Map(items.map((it) => [it.id, it.id]))
  const find = (id: string): string => {
    let r = id
    while (root.get(r) !== r) r = root.get(r)!
    root.set(id, r)
    return r
  }
  for (const [a, bs] of out) for (const b of bs) root.set(find(a), find(b))
  const comps = new Map<string, LayoutItem[]>()
  for (const it of order) {
    const r = find(it.id)
    const list = comps.get(r)
    if (list) list.push(it)
    else comps.set(r, [it])
  }

  const pos = new Map<string, { x: number; y: number }>()
  let y = 0
  let widest = 0
  const singles: LayoutItem[] = []
  for (const comp of comps.values()) {
    if (comp.length === 1) {
      singles.push(comp[0]!)
      continue
    }
    const placed = layoutComponent(comp, out, rank, gapX, gapY)
    let w = 0
    let h = 0
    for (const it of comp) {
      const p = placed.get(it.id)!
      w = Math.max(w, p.x + it.w)
      h = Math.max(h, p.y + it.h)
      pos.set(it.id, { x: p.x, y: p.y + y })
    }
    widest = Math.max(widest, w)
    y += h + gap
  }

  // 孤立元素：逐行排开，超宽换行
  const limit = Math.max(widest, rowWidth)
  let x = 0
  let rowH = 0
  for (const it of singles) {
    if (x > 0 && x + it.w > limit) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    pos.set(it.id, { x, y })
    x += it.w + gapX
    rowH = Math.max(rowH, it.h)
  }
  return pos
}

/** 一个连通分量的分层布局；返回相对分量包围盒左上角的位置 */
function layoutComponent(
  comp: LayoutItem[],
  out: Map<string, Set<string>>,
  rank: Map<string, number>,
  gapX: number,
  gapY: number,
) {
  const ids = new Set(comp.map((it) => it.id))
  // 断环：按原顺序深度优先，指回栈内的边不参与分层
  const dag = new Map<string, string[]>(comp.map((it) => [it.id, []]))
  const state = new Map<string, 1 | 2>()
  const visit = (id: string) => {
    state.set(id, 1)
    const next = [...out.get(id)!].filter((n) => ids.has(n))
    next.sort((a, b) => rank.get(a)! - rank.get(b)!)
    for (const n of next) {
      const s = state.get(n)
      if (s === 1) continue
      dag.get(id)!.push(n)
      if (!s) visit(n)
    }
    state.set(id, 2)
  }
  for (const it of comp) if (!state.has(it.id)) visit(it.id)

  // 最长路径分层：每个元素在它所有上游的右边一层
  const preds = new Map<string, string[]>(comp.map((it) => [it.id, []]))
  for (const [a, bs] of dag) for (const b of bs) preds.get(b)!.push(a)
  const layer = new Map<string, number>()
  const indeg = new Map(comp.map((it) => [it.id, preds.get(it.id)!.length]))
  const queue = comp.filter((it) => indeg.get(it.id) === 0).map((it) => it.id)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    const l = Math.max(-1, ...preds.get(id)!.map((p) => layer.get(p)!)) + 1
    layer.set(id, l)
    for (const n of dag.get(id)!) {
      indeg.set(n, indeg.get(n)! - 1)
      if (indeg.get(n) === 0) queue.push(n)
    }
  }
  // 下游紧跟在最近的上游后面，避免源头被拉到很靠左
  for (const id of [...queue].reverse()) {
    const s = dag.get(id)!
    if (preds.get(id)!.length === 0 && s.length > 0) {
      layer.set(id, Math.min(...s.map((n) => layer.get(n)!)) - 1)
    }
  }

  const count = Math.max(...layer.values()) + 1
  const layers: LayoutItem[][] = Array.from({ length: count }, () => [])
  for (const it of comp) layers[layer.get(it.id)!]!.push(it)
  for (const l of layers) l.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x)

  // 同层纵向堆叠并以 0 为中线居中
  const cy = new Map<string, number>()
  const stack = (l: LayoutItem[]) => {
    const total = l.reduce((s, it) => s + it.h, 0) + gapY * (l.length - 1)
    let top = -total / 2
    for (const it of l) {
      cy.set(it.id, top + it.h / 2)
      top += it.h + gapY
    }
  }
  layers.forEach(stack)
  // 重心法：按相邻层邻居的平均高度重排，来回扫几遍
  const sweep = (l: LayoutItem[], nbrs: Map<string, string[]>) => {
    const key = new Map(
      l.map((it) => {
        const ns = nbrs.get(it.id)!
        return [
          it.id,
          ns.length ? ns.reduce((s, n) => s + cy.get(n)!, 0) / ns.length : cy.get(it.id)!,
        ]
      }),
    )
    l.sort((a, b) => key.get(a.id)! - key.get(b.id)!)
    stack(l)
  }
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < count; i++) sweep(layers[i]!, preds)
    for (let i = count - 2; i >= 0; i--) sweep(layers[i]!, dag)
  }

  const pos = new Map<string, { x: number; y: number }>()
  let x = 0
  let minY = Infinity
  for (const l of layers) {
    for (const it of l) {
      const top = cy.get(it.id)! - it.h / 2
      pos.set(it.id, { x, y: top })
      minY = Math.min(minY, top)
    }
    x += Math.max(0, ...l.map((it) => it.w)) + gapX
  }
  for (const p of pos.values()) p.y = Math.round(p.y - minY)
  return pos
}

/** Frame 内边距：上方多留节点标题的位置 */
const FRAME_PAD = { x: 40, top: 64, bottom: 40 }

/**
 * 整理元素（一个撤销步）。不传 ids 时整理整个画布；传了只整理这些元素（及其中 Frame 的内部），
 * 每组同父元素的元素以它们原包围盒的左上角为锚点。锁定的元素不动。返回改动的元素数。
 */
export function arrangeElements(
  doc: PleinDoc,
  ids?: Iterable<string>,
  opts: LayoutOptions = {},
): number {
  const tops = (ids ? topLevel(doc, ids).map((id) => doc.get(id)!) : doc.children(null)).filter(
    (el) => !el.locked,
  )
  // 布局在内存里自下而上算完（Frame 先整理内部、确定尺寸），最后一次写入
  const geo = new Map<string, { x: number; y: number; w: number; h: number }>()
  const rectOf = (el: CanvasElement) => geo.get(el.id) ?? el

  const links = [...doc.edges()].map((e) => [e.from[0], e.to[0]] as const)
  /** 把连线端点投影到这一组里：端点自身或包含它的那个 Frame */
  const project = (group: CanvasElement[]) => {
    const set = new Set(group.map((el) => el.id))
    const owner = (id: string) =>
      set.has(id) ? id : doc.ancestors(id).find((a) => set.has(a.id))?.id
    const out: Array<[string, string]> = []
    for (const [a, b] of links) {
      const pa = owner(a)
      const pb = owner(b)
      if (pa && pb && pa !== pb) out.push([pa, pb])
    }
    return out
  }
  const place = (group: CanvasElement[], ox: number, oy: number) => {
    const items = group.map((el) => ({ id: el.id, ...rectOf(el) }))
    const pos = layoutGraph(items, project(group), opts)
    let w = 0
    let h = 0
    for (const it of items) {
      const p = pos.get(it.id)!
      geo.set(it.id, { x: ox + p.x, y: oy + p.y, w: it.w, h: it.h })
      w = Math.max(w, p.x + it.w)
      h = Math.max(h, p.y + it.h)
    }
    return { w, h }
  }
  const arrangeFrame = (frame: CanvasElement) => {
    const kids = doc.children(frame.id).filter((el) => !el.locked)
    for (const k of kids) if (k.kind === 'frame') arrangeFrame(k)
    // 有锁定的子元素时不收放 Frame，免得把它挤出去
    if (kids.length === 0 || kids.length !== doc.children(frame.id).length) return
    const size = place(kids, FRAME_PAD.x, FRAME_PAD.top)
    geo.set(frame.id, {
      x: frame.x,
      y: frame.y,
      w: Math.round(size.w + FRAME_PAD.x * 2),
      h: Math.round(size.h + FRAME_PAD.top + FRAME_PAD.bottom),
    })
  }

  const byParent = new Map<string | null, CanvasElement[]>()
  for (const el of tops) {
    const p = doc.effectiveParent(el)
    const list = byParent.get(p)
    if (list) list.push(el)
    else byParent.set(p, [el])
  }
  for (const group of byParent.values()) {
    for (const el of group) if (el.kind === 'frame') arrangeFrame(el)
    if (group.length < 2) continue
    const ox = Math.min(...group.map((el) => el.x))
    const oy = Math.min(...group.map((el) => el.y))
    place(group, ox, oy)
  }

  const patches: Array<{ id: string } & ElementPatch> = []
  for (const [id, r] of geo) {
    const el = doc.get(id)!
    const next = { x: Math.round(r.x), y: Math.round(r.y), w: r.w, h: r.h }
    if (next.x !== el.x || next.y !== el.y || next.w !== el.w || next.h !== el.h) {
      patches.push({ id, ...next })
    }
  }
  if (patches.length === 0) return 0
  doc.undo.stopCapturing()
  updateElements(doc, patches)
  doc.undo.stopCapturing()
  return patches.length
}

// ── 放置：新元素找空位（界面和智能体共用） ─────────────────────

/** 空间查询：返回与 rect 相交的元素 id。界面传场景的 R 树，缺省时线性扫描文档 */
export type SpatialQuery = (rect: Rect) => Iterable<string>

const PLACE_GAP = 80

function scan(doc: PleinDoc): SpatialQuery {
  return (r) => {
    const out: string[] = []
    for (const el of doc.elements()) {
      const w = doc.worldRect(el.id)
      if (w && r.x < w.x + w.w && r.x + r.w > w.x && r.y < w.y + w.h && r.y + r.h > w.y)
        out.push(el.id)
    }
    return out
  }
}

/**
 * 参照元素右侧找一块 w×h 的空地（世界坐标左上角）：与参照元素垂直居中对齐，
 * 压住别的元素（Frame 除外）就挪到它们下面，最多挪 20 次。
 */
export function spotRightOf(
  doc: PleinDoc,
  sourceId: string,
  w: number,
  h: number,
  query: SpatialQuery = scan(doc),
): { x: number; y: number } {
  const r = doc.worldRect(sourceId) ?? { x: 0, y: 0, w: 0, h: 0 }
  const x = r.x + r.w + PLACE_GAP
  let y = r.y + r.h / 2 - h / 2
  for (let i = 0; i < 20; i++) {
    const hits = [...query({ x, y, w, h })].filter(
      (id) => id !== sourceId && doc.get(id)?.kind !== 'frame',
    )
    if (!hits.length) break
    y =
      Math.max(...hits.map((id) => (doc.worldRect(id)?.y ?? 0) + (doc.worldRect(id)?.h ?? 0))) + 40
  }
  return { x, y }
}

/** 没有参照元素时：放在全部顶层内容的右侧，与最上沿对齐，压住了就往下挪 */
export function spotAfterContent(doc: PleinDoc, w: number, h: number): { x: number; y: number } {
  const roots = doc.children(null).map((e) => doc.worldRect(e.id)!)
  if (!roots.length) return { x: 0, y: 0 }
  const rect = {
    x: Math.max(...roots.map((r) => r.x + r.w)) + PLACE_GAP * 1.5,
    y: Math.min(...roots.map((r) => r.y)),
    w,
    h,
  }
  const pad = PLACE_GAP / 2
  const hit = (r: Rect) =>
    rect.x < r.x + r.w + pad &&
    rect.x + rect.w + pad > r.x &&
    rect.y < r.y + r.h + pad &&
    rect.y + rect.h + pad > r.y
  for (let i = 0; i < 60 && roots.some(hit); i++) rect.y += Math.max(h, 120) / 2
  return { x: rect.x, y: rect.y }
}

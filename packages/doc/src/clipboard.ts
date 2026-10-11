import { createElements, ReadOnlyDocError, topLevel } from './commands'
import { compareZ, LOCAL_ORIGIN, type PleinDoc } from './doc'
import { newId } from './ids'
import type { CanvasElement, Edge, NewElement } from './types'

/** 复制粘贴的序列化格式，可放进系统剪贴板 */
export interface ClipboardData {
  plein: 1
  /** 父元素先于子元素；顶层元素是世界坐标，后代是相对父元素的局部坐标 */
  elements: CanvasElement[]
  /** 两端都在 elements 里的边 */
  edges: Edge[]
}

export function isClipboardData(v: unknown): v is ClipboardData {
  const d = v as ClipboardData | null
  return !!d && d.plein === 1 && Array.isArray(d.elements) && Array.isArray(d.edges)
}

/** 导出选中元素（含后代）及其内部连线 */
export function exportElements(doc: PleinDoc, ids: Iterable<string>): ClipboardData {
  const roots = topLevel(doc, ids)
    .map((id) => doc.get(id)!)
    .sort(compareZ)
  const elements: CanvasElement[] = []
  for (const root of roots) {
    const world = doc.worldRect(root.id)!
    elements.push({ ...root, x: world.x, y: world.y, parentId: null })
    // descendants 是深度优先，父元素总在子元素之前
    elements.push(...doc.descendants(root.id).sort((a, b) => depthOrder(doc, a, b)))
  }
  const inSet = new Set(elements.map((e) => e.id))
  const edges = [...doc.edges()].filter((e) => inSet.has(e.from[0]) && inSet.has(e.to[0]))
  return { plein: 1, elements, edges }
}

/** 深度优先序里父在前；同一父元素下按 z */
function depthOrder(doc: PleinDoc, a: CanvasElement, b: CanvasElement) {
  const da = doc.ancestors(a.id).length
  const db = doc.ancestors(b.id).length
  return da !== db ? da - db : compareZ(a, b)
}

export interface ImportOptions {
  /** 顶层元素的位移（世界坐标） */
  dx?: number
  dy?: number
  /** 顶层元素放进的容器；坐标会换算为它的局部坐标 */
  parentId?: string | null
}

/** 以新 id 导入，保留层级、相对顺序和内部连线。返回顶层元素的新 id */
export function importElements(
  doc: PleinDoc,
  data: ClipboardData,
  opts: ImportOptions = {},
): string[] {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const { dx = 0, dy = 0 } = opts
  const parent = opts.parentId ? doc.worldRect(opts.parentId) : undefined
  const parentId = parent ? opts.parentId! : null
  const remap = new Map(data.elements.map((e) => [e.id, newId('el')]))
  const roots: string[] = []

  doc.ydoc.transact(() => {
    // 按层级分批创建，保证父元素先存在
    const pending = [...data.elements]
    const created = new Set<string>()
    while (pending.length > 0) {
      const batch = pending.filter((e) => e.parentId === null || created.has(e.parentId))
      if (batch.length === 0) break
      const inputs: NewElement[] = batch.map((e) => {
        const isRoot = e.parentId === null
        const { id: _id, z: _z, parentId: _p, ...rest } = e
        return {
          ...rest,
          id: remap.get(e.id)!,
          x: isRoot ? e.x + dx - (parent?.x ?? 0) : e.x,
          y: isRoot ? e.y + dy - (parent?.y ?? 0) : e.y,
          parentId: isRoot ? parentId : remap.get(e.parentId!)!,
        }
      })
      createElements(doc, inputs)
      for (const e of batch) {
        created.add(e.id)
        if (e.parentId === null) roots.push(remap.get(e.id)!)
        pending.splice(pending.indexOf(e), 1)
      }
    }
    for (const e of data.edges) {
      const from = remap.get(e.from[0])
      const to = remap.get(e.to[0])
      if (!from || !to) continue
      const edge: Edge = { id: newId('edge'), from: [from, e.from[1]], to: [to, e.to[1]] }
      doc.edgeMap.set(edge.id, edge)
    }
  }, LOCAL_ORIGIN)
  return roots
}

/** 原地复制一份（默认向右下偏移），返回新的顶层 id */
export function duplicateElements(doc: PleinDoc, ids: Iterable<string>, dx = 24, dy = 24) {
  return importElements(doc, exportElements(doc, ids), { dx, dy })
}

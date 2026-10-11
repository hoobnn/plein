import * as Y from 'yjs'

/** 画布上一切皆元素；有 ports 的元素才参与工作流。 */
export type ElementKind =
  | 'image'
  | 'video'
  | 'markdown'
  | 'group'
  | 'generator'
  | 'llm'

export interface Port {
  id: string
  label: string
  type: 'image' | 'video' | 'text' | 'any'
}

export interface CanvasElement {
  id: string
  kind: ElementKind
  x: number
  y: number
  w: number
  h: number
  /** 指向资源系统，二进制不进文档 */
  assetId?: string
  ports?: { inputs: Port[]; outputs: Port[] }
  params?: Record<string, unknown>
}

export interface Edge {
  id: string
  from: [elementId: string, portId: string]
  to: [elementId: string, portId: string]
}

export interface PleinDoc {
  ydoc: Y.Doc
  elements: Y.Map<CanvasElement>
  edges: Y.Map<Edge>
  undo: Y.UndoManager
}

export function createDoc(ydoc = new Y.Doc()): PleinDoc {
  const elements = ydoc.getMap<CanvasElement>('elements')
  const edges = ydoc.getMap<Edge>('edges')
  const undo = new Y.UndoManager([elements, edges], { captureTimeout: 300 })
  return { ydoc, elements, edges, undo }
}

export function upsertElement(doc: PleinDoc, el: CanvasElement) {
  doc.elements.set(el.id, el)
}

/**
 * 连接两个端口。一个输入端口只接一条边：已有的连线会被替换。
 * 返回新边；自连或重复连线时返回 null。
 */
export function connectPorts(
  doc: PleinDoc,
  from: Edge['from'],
  to: Edge['to'],
): Edge | null {
  if (from[0] === to[0]) return null
  let created: Edge | null = null
  doc.ydoc.transact(() => {
    for (const [id, e] of doc.edges) {
      if (e.to[0] !== to[0] || e.to[1] !== to[1]) continue
      if (e.from[0] === from[0] && e.from[1] === from[1]) return
      doc.edges.delete(id)
    }
    created = { id: `edge-${crypto.randomUUID()}`, from, to }
    doc.edges.set(created.id, created)
  })
  return created
}

export function removeEdge(doc: PleinDoc, id: string) {
  doc.edges.delete(id)
}

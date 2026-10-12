import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  createElement,
  currentResult,
  elementPorts,
  type NewElement,
  type Port,
  type PortType,
  type ResultValue,
} from '@plein/doc'
import type { Catalog } from '@plein/protocol'

export type NodeInfo = Catalog['nodes'][number]

/** 节点参数的 JSON Schema 字段（zod.toJSONSchema 生成，含 meta 提示） */
export interface FieldSchema {
  type?: string
  title?: string
  description?: string
  placeholder?: string
  widget?: string
  enum?: unknown[]
  minimum?: number
  maximum?: number
  default?: unknown
}

export function fieldsOf(node: NodeInfo): Array<[string, FieldSchema]> {
  const props = (node.paramsSchema as { properties?: Record<string, FieldSchema> }).properties
  return Object.entries(props ?? {})
}

/** 按类型取已安装的节点声明（同类型多版本时取最新） */
export function findNode(catalog: Catalog | null, type: string | undefined): NodeInfo | undefined {
  if (!catalog || !type) return undefined
  let best: NodeInfo | undefined
  for (const n of catalog.nodes) {
    if (n.type === type && (!best || n.version > best.version)) best = n
  }
  return best
}

/** 不调模型的节点（如文本）：参数即结果，不需要“生成” */
export const isPure = (node: NodeInfo) => !node.capability

/** 主提示词字段：卡片和生成器里最显眼的那个输入框 */
export function promptKey(node: NodeInfo): string | undefined {
  const fields = fieldsOf(node)
  for (const key of ['prompt', 'text']) {
    if (fields.some(([k, f]) => k === key && f.widget === 'textarea')) return key
  }
  return fields.find(([, f]) => f.widget === 'textarea')?.[0]
}

/** 节点在画布上的默认尺寸：出图 / 视频的节点留出预览区 */
function nodeSize(node: NodeInfo) {
  const out = node.outputs[0]?.type
  if (out === 'image' || out === 'video') return { w: 320, h: 300 }
  if (out === 'audio') return { w: 300, h: 180 }
  return { w: 280, h: 200 }
}

/** 由节点声明生成画布上的节点元素 */
export function nodeElement(node: NodeInfo): Omit<NewElement, 'x' | 'y'> {
  const port = (p: NodeInfo['inputs'][number]): Port => ({
    id: p.id,
    label: p.label,
    type: p.type,
    ...(p.multiple ? { multiple: true } : {}),
    ...(p.required ? { required: true } : {}),
  })
  const { w, h } = nodeSize(node)
  const rows = Math.max(node.inputs.length, node.outputs.length)
  return {
    kind: 'node',
    nodeType: node.type,
    nodeVersion: node.version,
    name: node.title,
    params: node.defaults,
    w,
    h: Math.max(h, 64 + rows * 28),
    ports: { inputs: node.inputs.map(port), outputs: node.outputs.map(port) },
  }
}

const accepts = (a: PortType, b: PortType) => a === 'any' || b === 'any' || a === b

/** 能接上某个端口的节点：从输出拉出时找有对应输入的节点，反之亦然 */
export function compatibleNodes(nodes: NodeInfo[], from: { type: PortType; side: 'in' | 'out' }) {
  return nodes.filter((n) =>
    (from.side === 'out' ? n.inputs : n.outputs).some((p) => accepts(p.type, from.type)),
  )
}

/**
 * 在世界坐标 at 新建元素。from 给出时自动连线：
 * 从输出端口拉出 → 新节点放在右侧，连到它第一个兼容的输入；从输入端口拉出则反过来。
 * at 落在 Frame 里时建在 Frame 内。
 */
export function placeElement(
  engine: Engine,
  input: Omit<NewElement, 'x' | 'y'>,
  at: { x: number; y: number },
  from?: { elementId: string; port: Port; side: 'in' | 'out' },
): string {
  const { scene } = engine
  const frame = scene.hitTest(at.x, at.y, (id) => scene.get(id)?.kind === 'frame')
  const origin = (frame && scene.rect(frame)) || { x: 0, y: 0 }
  let x = at.x - input.w / 2
  if (from?.side === 'out') x = at.x
  if (from?.side === 'in') x = at.x - input.w
  const id = createElement(engine.doc, {
    ...input,
    parentId: frame,
    x: Math.round(x - origin.x),
    y: Math.round(at.y - input.h / 2 - origin.y),
  } as NewElement)
  if (from) {
    const el = engine.doc.get(id)
    const ports = el ? elementPorts(el) : undefined
    if (from.side === 'out') {
      const target = ports?.inputs.find((p) => accepts(p.type, from.port.type))
      if (target) connect(engine.doc, [from.elementId, from.port.id], [id, target.id])
    } else {
      const source = ports?.outputs.find((p) => accepts(p.type, from.port.type))
      if (source) connect(engine.doc, [id, source.id], [from.elementId, from.port.id])
    }
  }
  // 立即同步到场景，选中和生成器才能拿到新元素的位置
  engine.doc.flush()
  engine.selection.set([id])
  engine.setTool('select')
  return id
}

/** 连到某个输入端口的一个上游 */
export interface Upstream {
  edgeId: string
  source: CanvasElement
  /** 上游当前能提供的值；为空表示还没有结果 */
  value?: ResultValue
}

/** 节点各输入端口的上游，按画布位置从上到下排列（与服务端收集顺序一致） */
export function upstreams(
  engine: Engine,
  id: string,
  catalog: Catalog | null,
): Map<string, Upstream[]> {
  const { doc } = engine
  const out = new Map<string, Upstream[]>()
  const edges = [...doc.edges()].filter((e) => e.to[0] === id)
  const pos = (eid: string) => doc.worldRect(eid) ?? { x: 0, y: 0 }
  edges.sort((a, b) => pos(a.from[0]).y - pos(b.from[0]).y || pos(a.from[0]).x - pos(b.from[0]).x)
  for (const e of edges) {
    const source = doc.get(e.from[0])
    if (!source) continue
    let value: ResultValue | undefined
    if (source.kind === 'markdown') value = { type: 'text', text: source.text ?? '' }
    else if (source.kind === 'node') {
      value = currentResult(source, e.from[1])?.value
      // 纯节点（如文本）没有结果时，运行下游会就地计算：它的主文本就是输出
      const info = findNode(catalog, source.nodeType)
      const key = info && isPure(info) ? promptKey(info) : undefined
      if (!value && key) value = { type: 'text', text: String(source.params?.[key] ?? '') }
    } else if (
      (source.kind === 'image' || source.kind === 'video' || source.kind === 'audio') &&
      source.assetId
    )
      value = { type: source.kind, assetId: source.assetId }
    const list = out.get(e.to[1]) ?? []
    list.push({ edgeId: e.id, source, value })
    out.set(e.to[1], list)
  }
  return out
}

/**
 * 运行前校验，返回第一条不满足的原因（null 表示可以运行）。
 * 与服务端执行器的检查一致，提前在界面上说明，而不是跑了再报错。
 */
export function validate(
  node: NodeInfo,
  el: CanvasElement,
  ups: Map<string, Upstream[]>,
  catalog: Catalog | null,
): string | null {
  if (isPure(node)) return null
  if (!node.executable) return '这个节点还没有执行器'
  if (node.capability && catalog) {
    const ok = catalog.providers.some(
      (p) =>
        p.enabled &&
        p.configured &&
        p.models.some((m) => m.capabilities.includes(node.capability!)),
    )
    if (!ok) return '没有启用支持这个能力的平台，请先在设置里配置'
  }
  for (const port of node.inputs) {
    const list = ups.get(port.id) ?? []
    if (port.required && list.length === 0) return `需要连入${port.label}`
    const pending = list.find((u) => !u.value)
    if (pending) return `上游「${pending.source.name ?? '节点'}」还没有结果`
  }
  const key = promptKey(node)
  if (key) {
    const own = String(el.params?.[key] ?? '').trim()
    const textPort = node.inputs.find((p) => p.type === 'text')
    const upstreamText = textPort
      ? (ups.get(textPort.id) ?? []).some((u) => u.value?.type === 'text' && u.value.text.trim())
      : false
    if (!own && !upstreamText) {
      const label = fieldsOf(node).find(([k]) => k === key)?.[1].title ?? '提示词'
      return textPort ? `填写${label}，或连入上游文本` : `填写${label}`
    }
  }
  return null
}

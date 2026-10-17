import { mentionElements as mentionElementsIn, type NodeFactory } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import {
  type CanvasElement,
  connect,
  inputEdges,
  createElement,
  currentResult,
  elementPorts,
  type NewElement,
  nodeSize,
  parseAspect,
  type Port,
  type PortType,
  portsCompatible,
  type ResultValue,
  aspectSize,
  updateElement,
  videoAssetOf,
} from '@plein/doc'
import { type MentionTarget, mentionName, profileOf } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { modelProblem, selectedModel } from './modelParams'

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

/** 就地计算的节点（如文本）：参数即结果，不需要“生成” */
export const isPure = (node: NodeInfo) => node.execution === 'inline'

/** 主提示词字段：卡片和生成器里最显眼的那个输入框 */
export function promptKey(node: NodeInfo): string | undefined {
  const fields = fieldsOf(node)
  for (const key of ['prompt', 'text']) {
    if (fields.some(([k, f]) => k === key && f.widget === 'textarea')) return key
  }
  return fields.find(([, f]) => f.widget === 'textarea')?.[0]
}

/** 画幅值的显示文字：auto 显示为「智能」 */
export function aspectLabel(v: unknown) {
  return v === 'auto' ? '智能' : String(v ?? '')
}

/** 节点里表示画幅的参数名 */
export function aspectKey(node: NodeInfo): string | undefined {
  return fieldsOf(node).find(([k, f]) => /aspect/i.test(k) && f.enum)?.[0]
}

/** 节点在画布上的默认尺寸：出图 / 视频的节点按默认画幅取形状 */
function defaultSize(node: NodeInfo) {
  const key = aspectKey(node)
  return nodeSize(node.outputs[0]?.type, key ? parseAspect(node.defaults?.[key]) : null)
}

/**
 * 改画幅时卡片跟着变形：保持长边和中心不动。
 * 用户手动缩放过的大小按其长边换算，不会突然变回默认大小。
 * 已经有视频结果时卡片跟视频走（见 videoAspect.ts），新画幅等生成后再体现。
 */
export function applyAspect(engine: Engine, id: string, value: unknown) {
  const ratio = parseAspect(value)
  const el = engine.doc.get(id)
  if (!ratio || !el || videoAssetOf(el)) return
  const { w, h } = aspectSize(ratio, Math.max(el.w, el.h))
  if (Math.abs(w - el.w) < 1 && Math.abs(h - el.h) < 1) return
  updateElement(engine.doc, id, {
    w,
    h,
    x: Math.round(el.x + (el.w - w) / 2),
    y: Math.round(el.y + (el.h - h) / 2),
  })
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
  const { w, h } = defaultSize(node)
  return {
    kind: 'node',
    nodeType: node.type,
    nodeVersion: node.version,
    name: node.title,
    params: node.defaults,
    w,
    h,
    ports: { inputs: node.inputs.map(port), outputs: node.outputs.map(port) },
  }
}

type PortFrom = { elementId: string; port: Port; side: 'in' | 'out' }

/** 连接点上的全部端口：每侧只有一个连接点，拉线时按类型挑其中能接上的 */
export function handlePorts(engine: Engine, from: PortFrom): Port[] {
  const el = engine.doc.get(from.elementId)
  const ports = el ? elementPorts(el) : undefined
  return (from.side === 'in' ? ports?.inputs : ports?.outputs) ?? [from.port]
}

/** 能接上某个连接点的节点：从输出拉出时找有对应输入的节点，反之亦然 */
export function compatibleNodes(
  nodes: NodeInfo[],
  from: { types: PortType[]; side: 'in' | 'out' },
) {
  return nodes.filter((n) =>
    (from.side === 'out' ? n.inputs : n.outputs).some((p) =>
      from.types.some((t) => portsCompatible(p.type, t)),
    ),
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
  from?: PortFrom,
): string {
  const { scene } = engine
  const frame = scene.hitTest(at.x, at.y, (id) => scene.get(id)?.kind === 'frame')
  const origin = (frame && scene.rect(frame)) || { x: 0, y: 0 }
  let x = at.x - input.w / 2
  if (from?.side === 'out') x = at.x
  if (from?.side === 'in') x = at.x - input.w
  // 新建（连同自动连线）单独算一步撤销
  engine.doc.undo.stopCapturing()
  const id = createElement(engine.doc, {
    ...input,
    parentId: frame,
    x: Math.round(x - origin.x),
    y: Math.round(at.y - input.h / 2 - origin.y),
  } as NewElement)
  if (from) {
    const el = engine.doc.get(id)
    const ports = el ? elementPorts(el) : undefined
    // 新节点的第一个能接上的端口，配上连接点里与它类型兼容的那个
    const mine = handlePorts(engine, from)
    const theirs = (from.side === 'out' ? ports?.inputs : ports?.outputs) ?? []
    for (const p of theirs) {
      const f = mine.find((m) => portsCompatible(p.type, m.type))
      if (!f) continue
      if (from.side === 'out') connect(engine.doc, [from.elementId, f.id], [id, p.id])
      else connect(engine.doc, [id, p.id], [from.elementId, f.id])
      break
    }
  }
  engine.doc.undo.stopCapturing()
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

/** 节点各输入端口的上游，按文档中的稳定顺序排列。 */
export function upstreams(
  engine: Engine,
  id: string,
  catalog: Catalog | null,
): Map<string, Upstream[]> {
  const { doc } = engine
  const out = new Map<string, Upstream[]>()
  const edges = inputEdges(doc, id)
  for (const e of edges) {
    const source = doc.get(e.from[0])
    if (!source) continue
    let value: ResultValue | undefined
    if (source.kind === 'markdown') value = { type: 'text', text: source.text ?? '' }
    else if (source.kind === 'node') {
      value = currentResult(source, e.from[1])?.value
      // 纯节点（文本、资产卡）没有结果时，运行下游会就地计算
      const info = findNode(catalog, source.nodeType)
      if (!value && info && isPure(info)) {
        const out = info.outputs.find((p) => p.id === e.from[1])
        if (out?.type === 'text')
          value = { type: 'text', text: String(source.params?.[promptKey(info) ?? 'text'] ?? '') }
        else value = upstreams(engine, source.id, catalog).get('references')?.[0]?.value
      }
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
    const key = fieldsOf(node).find(([, f]) => f.widget === 'model')?.[0]
    if (key && !el.params?.[key]) return '选择模型'
  }
  // 参数按 schema 检查：协作者或旧版本写进文档的值可能越界
  for (const [key, f] of fieldsOf(node)) {
    const v = el.params?.[key]
    if (v === undefined || v === null || v === '') continue
    const label = f.title ?? key
    if (f.type === 'number' || f.type === 'integer') {
      const n = Number(v)
      if (!Number.isFinite(n)) return `参数「${label}」应为数字`
      if (f.type === 'integer' && !Number.isInteger(n)) return `参数「${label}」应为整数`
      if ((f.minimum !== undefined && n < f.minimum) || (f.maximum !== undefined && n > f.maximum))
        return `参数「${label}」应在 ${f.minimum ?? '−∞'}–${f.maximum ?? '∞'} 之间`
    } else if (f.enum && !f.enum.includes(v)) {
      return `参数「${label}」的值「${String(v)}」不在可选范围内`
    }
  }
  // 所选模型的约束（分辨率、画幅、时长、张数、参考图数量）
  if (catalog) {
    const params = { ...node.defaults, ...el.params }
    const problem = modelProblem(node, params, selectedModel(catalog, node, params)?.info, ups)
    if (problem) return problem
  }
  for (const port of node.inputs) {
    const list = ups.get(port.id) ?? []
    if (port.required && list.length === 0) return `需要连入${port.label}`
    const pending = list.find((u) => !u.value)
    if (pending) return `上游「${pending.source.name ?? '节点'}」还没有结果`
  }
  const key = promptKey(node)
  if (key && node.capability !== 'image.process') {
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

/**
 * 可被 @ 引用的元素：资产卡（角色、场景、道具、风格）和有名字的图片，与服务端解析规则一致。
 * 重名要保留成多条——名字指不明时由用户写 `@林夏#2` 消歧，这里合并掉就再也提示不了了。
 */
export function mentionTargets(engine: Engine): MentionTarget[] {
  const out: MentionTarget[] = []
  for (const el of engine.doc.elements()) {
    const name = mentionName(el)
    if (!name) continue
    const profile = el.nodeType === 'plein/character' ? profileOf(el.params?.profile) : undefined
    out.push({ id: el.id, name, ...(profile ? { profile } : {}) })
  }
  return out
}

/** 按名字取可引用元素；重名的全部返回，调用方要自己判断指不指得准 */
export const mentionElements = (engine: Engine) => mentionElementsIn(engine.doc)

/** 按 catalog 建卡片骨架，给 @plein/capabilities 里的纯文档操作用 */
export const nodeFactory =
  (catalog: Catalog | null): NodeFactory =>
  (type) => {
    const info = findNode(catalog, type)
    return info && nodeElement(info)
  }

/** 资产卡或图片的缩略图：资产卡取它连入的第一张参考图 */
export function targetImages(engine: Engine, el: CanvasElement): string[] {
  if (el.kind === 'image' && el.assetId) return [el.assetId]
  return [...engine.doc.edges()]
    .filter((e) => e.to[0] === el.id && e.to[1] === 'references')
    .flatMap((e) => {
      const src = engine.doc.get(e.from[0])
      if (src?.kind === 'image' && src.assetId) return [src.assetId]
      const r = src?.kind === 'node' ? currentResult(src, e.from[1])?.value : undefined
      return r?.type === 'image' ? [r.assetId] : []
    })
}

import {
  type CanvasElement,
  currentResult,
  elementPorts,
  type NodeResult,
  type PleinDoc,
} from '@plein/doc'

/** 给模型看的摘要：长文本截断，避免一次读画布把上下文撑爆 */

const LONG_TEXT = 400

export const clip = (s: string, n = LONG_TEXT) =>
  s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字）` : s

export function resultSummary(r: NodeResult) {
  const v = r.value
  const base = { result_id: r.id, port: r.port, type: v.type }
  if (v.type === 'text') return { ...base, text: clip(v.text) }
  if (v.type === 'json') return { ...base, value: clip(JSON.stringify(v.value)) }
  return { ...base, asset_id: v.assetId, ...(v.caption ? { caption: v.caption } : {}) }
}

/** 元素摘要；full 时不截断并带上全部历史结果 */
export function summarize(doc: PleinDoc, el: CanvasElement, full: boolean) {
  const r = doc.worldRect(el.id)!
  const out: Record<string, unknown> = {
    id: el.id,
    kind: el.kind,
    locked: el.locked,
    rotation: el.rotation,
    ...(el.color ? { color: el.color } : {}),
    ...(el.name ? { name: el.name } : {}),
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)],
  }
  const parent = doc.effectiveParent(el)
  if (parent) out.parent = parent
  if (el.text !== undefined) out.text = full ? el.text : clip(el.text)
  if (el.assetId) out.asset_id = el.assetId
  if (full) {
    if (el.kind !== 'node' && el.params) out.params = el.params
    out.z = el.z
    out.adopted = el.adopted
    if (el.reviews) out.reviews = el.reviews
    if (el.production) out.production = el.production
    if (el.deliveries) out.deliveries = el.deliveries
    if (el.videoSegment) out.video_segment = el.videoSegment
  }
  if (el.kind === 'node') {
    out.type = el.nodeType
    out.params = full
      ? el.params
      : Object.fromEntries(
          Object.entries(el.params ?? {}).map(([k, v]) => [k, typeof v === 'string' ? clip(v) : v]),
        )
    const ports = elementPorts(el)
    if (ports) {
      out.inputs = ports.inputs.map((p) => `${p.id}:${p.type}${p.multiple ? '[]' : ''}`)
      out.outputs = ports.outputs.map((p) => `${p.id}:${p.type}`)
    }
    if (el.run) {
      out.run = {
        status: el.run.status,
        ...(el.run.error ? { error: el.run.error } : {}),
        ...(el.run.progress !== undefined ? { progress: el.run.progress } : {}),
      }
    }
    const cur = currentResult(el)
    if (cur) out.current_result = resultSummary(cur)
    if (full && el.results?.length) out.results = el.results.map(resultSummary)
    else if (el.results && el.results.length > 1) out.result_count = el.results.length
  }
  return out
}

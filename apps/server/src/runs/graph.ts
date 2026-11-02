import { FlowGraph } from '@plein/flow'
import { SEQUENCE_TYPE, sequenceNode } from '@plein/nodes'
import { isSequenceInstance, type Edge, type PleinDoc, type ResultValue } from '@plein/doc'
import type { PortValue } from '@plein/plugin-sdk'
import { mentionEdges } from './mentions'

/** 调度用的依赖图：画布上的连线，加上提示词里 @ 引用带来的依赖 */
export function sequenceEdgeAllowed(doc: PleinDoc, edge: Edge) {
  const target = doc.get(edge.to[0])
  if (
    target?.nodeType !== SEQUENCE_TYPE ||
    (target.nodeVersion ?? 1) < 2 ||
    target.params?.instanceVersion !== 2
  )
    return true
  if (!['clips', 'dialogue', 'sfx'].includes(edge.to[1])) return true
  const parsed = sequenceNode.params.safeParse(target.params)
  if (!parsed.success || !parsed.data.clips.every(isSequenceInstance)) return false
  const rows = parsed.data.clips
  if (rows.some((row) => row.segment && row.sound === 'legacy')) return false
  if (edge.to[1] === 'clips')
    return rows.some(
      (row) =>
        !row.segment &&
        row.source === edge.from[0] &&
        row.port === edge.from[1] &&
        (!row.edgeId || row.edgeId === edge.id),
    )
  if (rows.some((row) => row.sound === 'legacy')) return true
  return rows.some((row) =>
    edge.to[1] === 'dialogue'
      ? row.sound !== 'native' && [row.dialogue, ...(row.more ?? [])].includes(edge.from[0])
      : row.sfx === edge.from[0],
  )
}

/** 可以进入调度图的连线 */
export function executionEdges(doc: PleinDoc) {
  return [...doc.edges()].filter((edge) => sequenceEdgeAllowed(doc, edge))
}

/** 调度用的完整依赖图：连线加上 @ 引用 */
export function runGraph(doc: PleinDoc) {
  return new FlowGraph([...executionEdges(doc), ...mentionEdges(doc)])
}

/** 端口值转成可发布的结果值 */
export function toPortValue(v: ResultValue): PortValue {
  if (v.type === 'text' || v.type === 'json') return v
  const out: PortValue = { type: v.type, assetId: v.assetId, kind: v.type, mime: v.mime }
  if (v.caption) out.caption = v.caption
  if (v.compositionSource) out.compositionSource = v.compositionSource
  return out
}

/** 端口值转回结果值 */
export function toResultValue(v: PortValue): ResultValue {
  if (v.type === 'text') return { type: 'text', text: v.text }
  if (v.type === 'json') return { type: 'json', value: v.value }
  const out: ResultValue = { type: v.type, assetId: v.assetId, mime: v.mime }
  if (v.caption) out.caption = v.caption
  if (v.compositionSource) out.compositionSource = v.compositionSource
  return out
}

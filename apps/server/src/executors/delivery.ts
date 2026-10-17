import { type DeliveryRecord, type NodeResult, type PleinDoc, SYSTEM_ORIGIN } from '@plein/doc'
import {
  ANIMATIC_TYPE,
  animaticNode,
  arrangeAnimatic,
  arrangeSequence,
  sequenceNode,
  sequenceSize,
  sequenceTimeline,
} from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'

type AssetInfo = { duration?: number; width?: number; height?: number }
export type DeliveryOrigins = Record<string, { shot?: string; storyboard?: string }>

/** 运行开始时冻结身份；导出期间源节点改绑或删除也不能改变成片来源。 */
export function freezeDeliveryOrigins(
  doc: PleinDoc,
  inputs: Record<string, PortValue[]>,
): DeliveryOrigins {
  const origins: DeliveryOrigins = {}
  for (const value of Object.values(inputs).flat()) {
    if (!value.source) continue
    const source = doc.get(value.source)?.params?.source as
      | { shot?: unknown; storyboard?: unknown }
      | undefined
    origins[value.source] = {
      ...(typeof source?.shot === 'string' ? { shot: source.shot } : {}),
      ...(typeof source?.storyboard === 'string' ? { storyboard: source.storyboard } : {}),
    }
  }
  return origins
}
/** 仅在实际媒体成功入库并建立 resultId 后追加；使用本次冻结输入，避免映射到后续编辑。 */
export function appendDeliveryRecord(
  doc: PleinDoc,
  nodeId: string,
  results: NodeResult[],
  frozenParams: Record<string, unknown> | undefined,
  frozenInputs: Record<string, PortValue[]>,
  info: (assetId: string) => AssetInfo | undefined,
  frozenOrigins?: DeliveryOrigins,
) {
  const el = doc.get(nodeId)
  if (!el || !['plein/sequence', ANIMATIC_TYPE].includes(el.nodeType ?? '')) return
  const draft = el.nodeType === ANIMATIC_TYPE
  const draftBoard = draft ? animaticNode.params.parse(frozenParams).boardId : undefined
  const params = draft
    ? animaticNode.params.parse(frozenParams)
    : sequenceNode.params.parse(frozenParams)
  const rows = draft
    ? arrangeAnimatic(animaticNode.params.parse(frozenParams))
    : arrangeSequence(params, frozenInputs)
  const timeline = sequenceTimeline(params, rows, {
    clips: rows.map((r) => (draft ? (r.out ?? 0) : (info(r.clip.assetId)?.duration ?? 0))),
    dialogue: rows.map((r) => (r.dialogue ? info(r.dialogue.assetId)?.duration : undefined)),
    more: rows.map((r) => r.more.map((m) => info(m.assetId)?.duration)),
  })
  const durationKnown = draft || rows.every((r) => info(r.clip.assetId)?.duration !== undefined)
  const prior = el.deliveries ?? []
  const origins = frozenOrigins ?? freezeDeliveryOrigins(doc, frozenInputs)
  let version = prior.length
  const fresh = results.flatMap((result): DeliveryRecord[] => {
    if (result.value.type !== 'video' || prior.some((r) => r.resultId === result.id)) return []
    const meta = info(result.value.assetId)
    const size = sequenceSize(params)
    const sources = (durationKnown ? rows : []).flatMap((row, i) => {
      const clip = timeline.clips[i]!
      if (!row.source || clip.length <= 0) return []
      const source = origins[row.source]
      return [
        {
          source: draft ? (row.clip.source ?? (draftBoard || row.source)) : row.source,
          shotId: draft ? row.source : source?.shot,
          start: clip.start,
          end: clip.start + clip.length,
        },
      ]
    })
    const boardId = draft
      ? draftBoard
      : rows.map((r) => origins[r.source ?? '']?.storyboard).find(Boolean)
    return [
      {
        id: `delivery_${result.id}`,
        resultId: result.id,
        runId: result.runId,
        assetId: result.value.assetId,
        kind: draft ? 'animatic' : 'film',
        version: `v${++version}`,
        createdAt: result.at,
        width: meta?.width ?? size.width,
        height: meta?.height ?? size.height,
        duration: meta?.duration ?? (durationKnown ? timeline.total : 0),
        boardId,
        sources,
        notes: [],
      },
    ]
  })
  if (fresh.length)
    doc.ydoc.transact(
      () => doc.mutable(nodeId)?.set('deliveries', [...fresh, ...prior]),
      SYSTEM_ORIGIN,
    )
}

import {
  createElement,
  currentResult,
  productionGoalHeads,
  spotRightOf,
  type DeliveryRecord,
  type PleinDoc,
} from '@plein/doc'
import {
  deliveryCheckNode,
  DeliveryCheckRequest,
  DeliveryCheckReport,
  DELIVERY_CHECK_TYPE,
  SubtitlePlanEvidence,
} from '@plein/nodes'
import { creationGuideFacts } from '../creation-guide/facts'

export function deliveryCheckBoards(
  doc: PleinDoc,
  canvasId: string,
  sequenceId: string,
  record: DeliveryRecord,
) {
  return [...doc.elements()].filter(
    (el) =>
      el.nodeType === 'plein/storyboard' &&
      (record.boardId === el.id ||
        el.production?.goals?.some(
          (goal) =>
            !goal.historical &&
            goal.scope.canvasId === canvasId &&
            goal.scope.boardId === el.id &&
            goal.scope.sequenceId === sequenceId,
        ) ||
        creationGuideFacts(doc, { canvasId, boardId: el.id }).sequences.some(
          (sequence) => sequence.id === sequenceId,
        )),
  )
}
export function deliveryCheckRequest(
  doc: PleinDoc,
  canvasId: string,
  sequenceId: string,
  deliveryId: string,
  boardId: string | undefined,
) {
  const sequence = doc.get(sequenceId)
  const record = sequence?.deliveries?.find((item) => item.id === deliveryId)
  if (sequence?.nodeType !== 'plein/sequence' || !record || record.kind !== 'film')
    throw new Error('实际成片版本已移除或不是正式成片')
  const boards = deliveryCheckBoards(doc, canvasId, sequenceId, record)
  const board = boardId
    ? boards.find((item) => item.id === boardId)
    : boards.length === 1
      ? boards[0]
      : undefined
  if (!board)
    throw new Error(
      boards.length
        ? '请明确选择这份成片对应的分镜目标'
        : '没有可核对的分镜目标，请在制作总览保存这个范围的目标',
    )
  const scope = { canvasId, boardId: board.id, sequenceId }
  const heads = productionGoalHeads(board, scope)
  if (heads.length !== 1)
    throw new Error(
      heads.length
        ? '制作目标有并发修订，请先核对合并'
        : '这个分镜／序列范围尚无目标版本，请先在制作总览保存',
    )
  const evidence = SubtitlePlanEvidence.safeParse(record.subtitleEvidence)
  const request = DeliveryCheckRequest.parse({
    scope,
    deliveryId: record.id,
    runId: record.runId,
    resultId: record.resultId,
    source: { assetId: record.assetId, kind: 'video', mime: 'video/mp4' },
    goal: { id: heads[0]!.id, snapshot: heads[0]!.snapshot },
    ...(evidence.success &&
    record.subtitleEvidence?.assetId === record.assetId &&
    record.subtitleEvidence.resultId === record.resultId
      ? { subtitles: { ...evidence.data, assetId: record.assetId, resultId: record.resultId } }
      : {}),
  })
  return request
}
export function deliveryReports(doc: PleinDoc, sequenceId: string) {
  return [...doc.elements()]
    .filter((el) => el.nodeType === DELIVERY_CHECK_TYPE)
    .flatMap((node) =>
      (node.results ?? []).flatMap((result) => {
        const parsed = DeliveryCheckReport.safeParse(
          result.value.type === 'json' && result.port === 'report' ? result.value.value : undefined,
        )
        if (!parsed.success) return []
        const target = node.params?.request as DeliveryCheckRequest | undefined
        return parsed.data.request.scope.sequenceId === sequenceId ||
          target?.scope?.sequenceId === sequenceId
          ? [
              {
                node,
                result,
                report: parsed.data,
                adopted: currentResult(node, 'report')?.id === result.id,
              },
            ]
          : []
      }),
    )
    .sort((a, b) => b.result.at - a.result.at || b.result.id.localeCompare(a.result.id))
}
export function isCurrentDeliveryReport(
  doc: PleinDoc,
  request: DeliveryCheckRequest,
  entry: ReturnType<typeof deliveryReports>[number],
) {
  const sequence = doc.get(request.scope.sequenceId)
  if (!sequence) return false
  const check = doc.get(entry.node.id)
  if (
    check?.nodeType !== DELIVERY_CHECK_TYPE ||
    check.params?.historical === true ||
    currentResult(check, 'report')?.id !== entry.result.id
  )
    return false
  let now: DeliveryCheckRequest
  try {
    now = deliveryCheckRequest(
      doc,
      request.scope.canvasId,
      request.scope.sequenceId,
      request.deliveryId,
      request.scope.boardId,
    )
  } catch {
    return false
  }
  if (JSON.stringify(now) !== JSON.stringify(request)) return false
  const output = currentResult(sequence, 'video')
  return (
    entry.adopted &&
    entry.node.params?.historical !== true &&
    output?.id === request.resultId &&
    output.value.type === 'video' &&
    output.value.assetId === request.source.assetId &&
    JSON.stringify(entry.report.request) === JSON.stringify(request)
  )
}
/** Explicit click only. Source/goal snapshots live in this job; opening the panel creates nothing. */
export function createDeliveryCheck(doc: PleinDoc, request: DeliveryCheckRequest) {
  const point = spotRightOf(doc, request.scope.sequenceId, 300, 160)
  doc.undo.stopCapturing()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: DELIVERY_CHECK_TYPE,
    nodeVersion: 1,
    name: `技术检查 · ${request.resultId.slice(-8)}`,
    params: deliveryCheckNode.params.parse({ request }),
    ports: { inputs: [], outputs: deliveryCheckNode.outputs },
    x: point.x,
    y: point.y,
    w: 300,
    h: 160,
  })
  doc.undo.stopCapturing()
  doc.flush()
  return id
}

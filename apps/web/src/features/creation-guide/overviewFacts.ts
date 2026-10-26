import { activeShotNodes, expandedNodes } from '@plein/capabilities'
import {
  currentResult,
  getCreativeReview,
  isDeliveryRecord,
  type CanvasElement,
  type PleinDoc,
} from '@plein/doc'
import { sequenceNode, sequenceSize } from '@plein/nodes'
import type { JobInfo } from '@plein/protocol'
import type { GuideFacts, GuideTarget } from './facts'
import { describeRecovery } from '../runs/recovery'
import type { StaleKind } from '../runs/stale'

export interface OverviewIssue {
  id: string
  message: string
  target?: GuideTarget
  task?: boolean
}
export function overviewNodes(doc: PleinDoc, facts: GuideFacts): CanvasElement[] {
  if (!facts.board) return []
  const groups = expandedNodes(doc, facts.board.id)
  return facts.shots.flatMap((shot) => activeShotNodes(shot, groups.get(shot.id) ?? []))
}
/** 从现有文档与最新任务推导；只读，不从聊天、目标文字或成功状态推断审片通过。 */
export function productionOverviewFacts(
  doc: PleinDoc,
  facts: GuideFacts,
  options: {
    stale?: ReadonlyMap<string, StaleKind>
    jobs?: JobInfo[]
  } = {},
) {
  const nodes = overviewNodes(doc, facts)
  const media = (el: CanvasElement) =>
    (el.results ?? []).filter((r) => ['image', 'audio', 'video'].includes(r.value.type))
  const adopted = nodes.filter((el) => currentResult(el))
  const issues: OverviewIssue[] = facts.steps
    .filter((s) => s.state === 'attention')
    .map((s) => ({ id: `step-${s.id}`, message: s.detail, target: s.target }))
  const reviews = adopted.filter((el) => getCreativeReview(el)?.status !== 'usable')
  for (const el of reviews) {
    const result = currentResult(el)!
    issues.push({
      id: `review-${el.id}`,
      message: `${el.name ?? '生成节点'}：${getCreativeReview(el)?.status === 'changes' ? '人工标记需修改' : '采用候选待人工审看'}`,
      target: { kind: 'review', nodeId: el.id, resultId: result.id },
    })
  }
  for (const el of nodes) {
    const kind = options.stale?.get(el.id)
    if (kind)
      issues.push({
        id: `stale-${el.id}`,
        message: `${el.name ?? '生成节点'}：${kind === 'kept' ? '已保留旧输入的结果，未核对新目标' : kind === 'upstream' ? '上游输入已变化' : '当前结果对应旧输入'}`,
        target: { kind: 'generator', nodeId: el.id },
      })
    if (!currentResult(el) && media(el).length)
      issues.push({
        id: `candidate-${el.id}`,
        message: `${el.name ?? '生成节点'}：已有产物，等待选择采用`,
        target: { kind: 'generator', nodeId: el.id },
      })
  }
  const sequenceStale = facts.sequence && options.stale?.get(facts.sequence.id)
  if (facts.sequence && sequenceStale)
    issues.push({
      id: `stale-${facts.sequence.id}`,
      message: `当前成片：${sequenceStale === 'kept' ? '已明确保留旧输入的结果' : '序列输入已变化，交付前需检查'}`,
      target: { kind: 'sequence', nodeId: facts.sequence.id },
    })
  const nodeIds = new Set([
    ...nodes.map((el) => el.id),
    ...(facts.sequence ? [facts.sequence.id] : []),
  ])
  const jobs = (options.jobs ?? []).filter((job) => nodeIds.has(job.nodeId))
  for (const job of jobs) {
    const recovery = describeRecovery(job)
    const currentRun = doc.get(job.nodeId)?.run
    if (
      recovery ||
      ((!currentRun || currentRun.id === job.id) &&
        (job.status === 'failed' || job.status === 'canceled'))
    )
      issues.push({
        id: `job-${job.id}`,
        message: `${doc.get(job.nodeId)?.name ?? '任务'}：${recovery?.title ?? (job.status === 'failed' ? '上次任务失败' : '上次任务已取消')}`,
        target: { kind: 'generator', nodeId: job.nodeId },
        task: true,
      })
  }
  const result = facts.sequence && currentResult(facts.sequence)
  const delivery =
    result &&
    facts.sequence?.deliveries
      ?.filter(isDeliveryRecord)
      .find(
        (r) =>
          r.kind === 'film' &&
          !r.historical &&
          r.resultId === result.id &&
          result.value.type === 'video' &&
          r.assetId === result.value.assetId,
      )
  const params = facts.sequence && sequenceNode.params.safeParse(facts.sequence.params ?? {})
  return {
    nodes,
    issues,
    total: nodes.length,
    produced: nodes.filter((el) => media(el).length > 0).length,
    candidates: nodes.reduce((n, el) => n + media(el).length, 0),
    adopted: adopted.length,
    usable: adopted.filter((el) => getCreativeReview(el)?.status === 'usable').length,
    stale: nodes.filter((el) => options.stale?.has(el.id)).length,
    working: nodes.filter((el) => el.run?.status === 'running' || el.run?.status === 'queued')
      .length,
    sequenceWorking:
      facts.sequence?.run?.status === 'running' || facts.sequence?.run?.status === 'queued',
    delivered: facts.steps.find((s) => s.id === 'delivery')?.state === 'done',
    planDuration: facts.shots.reduce((n, shot) => n + shot.duration, 0),
    delivery,
    sequenceSettings: params?.success
      ? {
          ...sequenceSize(params.data),
          subtitles: params.data.subtitles,
          aspectRatio: params.data.aspectRatio,
          resolution: params.data.resolution,
        }
      : undefined,
  }
}

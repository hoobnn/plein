/** 基线脚手架只汇总带来源的观测，不把缺失测量补成0，也不推断创作质量。 */
export interface BaselineEvent {
  id: string
  type: 'human-action' | 'provider-submit'
  /** 仅真实调用入口的submit事件可计数，不用poll、下载、结果数量代替。 */
  capability?: string
}
export interface BaselineObservation {
  runId: string
  fixtureId: string
  evidence: string[]
  firstShotComplete: boolean | null
  events: BaselineEvent[] | null
  quality: 'pending-manual' | 'reviewed'
}
export interface BaselineMeasurements {
  observedRuns: number
  pendingRuns: number
  firstShotCompletions: number
  firstShotCompletionRate: number | null
  humanActions: number | null
  videoSubmits: number | null
  pendingManualReviews: number
}

export function summarizeBaseline(
  observations: readonly BaselineObservation[],
): BaselineMeasurements {
  if (new Set(observations.map((run) => run.runId)).size !== observations.length)
    throw new Error('同一运行不能重复计入基线')
  if (
    observations.some(
      (run) =>
        (run.firstShotComplete !== null || run.events !== null || run.quality === 'reviewed') &&
        !run.evidence.length,
    )
  )
    throw new Error('已测量结果必须附带真实证据路径')
  const measured = observations.filter((run) => run.firstShotComplete !== null)
  const eventComplete = observations.length > 0 && observations.every((run) => run.events !== null)
  const events = observations.flatMap((run) => {
    const list = run.events ?? []
    if (new Set(list.map((event) => event.id)).size !== list.length)
      throw new Error('同一运行中的动作或submit不能重复计数')
    return list
  })
  const completions = measured.filter((run) => run.firstShotComplete === true).length
  return {
    observedRuns: measured.length,
    pendingRuns: observations.length - measured.length,
    firstShotCompletions: completions,
    firstShotCompletionRate: measured.length ? completions / measured.length : null,
    humanActions: eventComplete
      ? events.filter((event) => event.type === 'human-action').length
      : null,
    videoSubmits: eventComplete
      ? events.filter(
          (event) => event.type === 'provider-submit' && event.capability === 'video.generate',
        ).length
      : null,
    pendingManualReviews: observations.filter((run) => run.quality === 'pending-manual').length,
  }
}

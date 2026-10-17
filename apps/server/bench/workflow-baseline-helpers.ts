import { Shot } from '@plein/nodes'
import { z } from 'zod'

export const CreativeBaselineFixture = z.object({
  format: z.literal('plein-creative-baseline'),
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  brief: z.string().min(1),
  aspectRatio: z.enum(['9:16', '16:9']),
  trialShotId: z.string(),
  shots: z.array(Shot).min(1),
  manualChecks: z.array(z.string()).min(1),
})
export type CreativeBaselineFixture = z.infer<typeof CreativeBaselineFixture>
export interface BaselineSubmit {
  id: string
  fixtureId: string
  phase: string
  capability: string
  model: string
  startedAt: number
  finishedAt?: number
  outcome?: 'succeeded' | 'pending' | 'threw'
}

/** 在 provider.submit 入口记录，失败和结果未知也计数；poll、下载、候选不参与此计数。 */
export function countBaselineSubmits(events: readonly BaselineSubmit[]) {
  if (new Set(events.map((event) => event.id)).size !== events.length)
    throw new Error('submit事件ID重复，拒绝重复计数')
  const byCapability: Record<string, number> = {}
  for (const event of events)
    byCapability[event.capability] = (byCapability[event.capability] ?? 0) + 1
  return { total: events.length, byCapability, video: byCapability['video.generate'] ?? 0 }
}

export function candidateDelta(
  before: Readonly<Record<string, readonly string[]>>,
  after: Readonly<Record<string, readonly string[]>>,
) {
  const removed: Array<{ nodeId: string; resultId: string }> = []
  const added: Array<{ nodeId: string; resultId: string }> = []
  for (const [nodeId, ids] of Object.entries(before))
    for (const resultId of ids)
      if (!after[nodeId]?.includes(resultId)) removed.push({ nodeId, resultId })
  for (const [nodeId, ids] of Object.entries(after))
    for (const resultId of ids)
      if (!before[nodeId]?.includes(resultId)) added.push({ nodeId, resultId })
  return { removed, added }
}

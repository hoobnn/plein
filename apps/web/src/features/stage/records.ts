import { type CanvasElement, currentResult } from '@plein/doc'
import { type StageSnapshot, stageSnapshotsOf } from '@plein/nodes'

export interface StageRecord {
  key: string
  resultId: string
  assetId: string
  snapshot?: StageSnapshot
  available: boolean
  adopted: boolean
  issue?: 'missing' | 'removed' | 'mismatch'
}

/** 图片候选和可恢复场景分别核对，缺失来源不能补成默认场景，也不能采用已移除候选。 */
export function stageRecordsOf(el: CanvasElement | undefined) {
  const snapshots = stageSnapshotsOf(el?.params)
  const sources = new Map(snapshots.map((s) => [s.resultId, s]))
  const adopted = el && currentResult(el, 'image')?.id
  const records: StageRecord[] = []
  const matched = new Set<string>()
  const seen = new Set<string>()
  for (const result of el?.results ?? []) {
    if (
      seen.has(result.id) ||
      result.port !== 'image' ||
      result.value.type !== 'image' ||
      typeof result.value.assetId !== 'string' ||
      !result.value.assetId
    )
      continue
    seen.add(result.id)
    const source = sources.get(result.id)
    const snapshot = source?.assetId === result.value.assetId ? source : undefined
    if (snapshot) matched.add(snapshot.resultId)
    records.push({
      key: `result:${result.id}`,
      resultId: result.id,
      assetId: result.value.assetId,
      snapshot,
      available: true,
      adopted: result.id === adopted,
      issue: snapshot ? undefined : 'missing',
    })
  }
  for (const snapshot of snapshots) {
    if (matched.has(snapshot.resultId)) continue
    records.push({
      key: `source:${snapshot.resultId}`,
      resultId: snapshot.resultId,
      assetId: snapshot.assetId,
      snapshot,
      available: false,
      adopted: false,
      issue: seen.has(snapshot.resultId) ? 'mismatch' : 'removed',
    })
  }
  return records
}

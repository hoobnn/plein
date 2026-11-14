import type * as Y from 'yjs'
import { readResults } from '../results'
import { type GenerationOrigin, type VideoSegment, isVideoSegment } from './video-segment'

type ElementLookup = (id: string) => Y.Map<unknown> | undefined

/**
 * 导入或恢复后核实固定片段的本地候选位置。
 *
 * 只有下面每一项都对得上，才建立本地联系：
 * - 来源画布和运行都有明确的 id 映射（来源不在本次迁入范围内就不猜）；
 * - 来源节点确实在恢复后的文档里；
 * - 该节点上还有当时的候选，端口、运行、视频文件都和片段记录一致。
 *
 * 孤立片段、同名节点、同一候选 id 但换了文件或运行，一律不建立联系，
 * 保留原来的历史 `selection` 继续说明它来自哪次生成。
 */
export function verifiedLocalSelection(
  segment: VideoSegment,
  lookup: ElementLookup,
  map: ReadonlyMap<string, string>,
): GenerationOrigin | undefined {
  // 已经建立过本地位置时，以它为准继续核对：检查点恢复只映射当前画布，
  // 历史 selection 里的旧画布 id 在映射里没有，不能因此丢掉上一轮核实的结果。
  for (const selection of [segment.localSelection, segment.selection]) {
    if (!selection) continue
    const canvasId = map.get(selection.canvasId)
    if (!canvasId) continue
    const nodeId = map.get(selection.nodeId) ?? selection.nodeId
    const m = lookup(nodeId)
    if (!m) continue
    const runId = map.get(selection.runId) ?? selection.runId
    const result = readResults(m).find((r) => r.id === selection.resultId)
    if (!result || result.port !== selection.port || result.runId !== runId) continue
    if (result.value.type !== 'video' || result.value.assetId !== segment.asset.assetId) continue
    return { canvasId, nodeId, port: selection.port, resultId: selection.resultId, runId }
  }
  return undefined
}

/**
 * 片段连同核实过的本地位置一起返回；核实失败或与已有内容一致时原样返回。
 * 历史 `selection` / `origin` 不动，旧交付证据仍然对得上。
 */
export function withVerifiedLocalSelection(
  segment: VideoSegment,
  lookup: ElementLookup,
  map: ReadonlyMap<string, string>,
): VideoSegment {
  const localSelection = verifiedLocalSelection(segment, lookup, map)
  if (!localSelection) return segment
  const current = segment.localSelection
  if (
    current &&
    current.canvasId === localSelection.canvasId &&
    current.nodeId === localSelection.nodeId &&
    current.port === localSelection.port &&
    current.resultId === localSelection.resultId &&
    current.runId === localSelection.runId
  )
    return segment
  return { ...segment, localSelection }
}

/** 序列实例的 clips 里每个固定片段都按同样规则核实本地位置；没有变化时原样返回 */
export function withVerifiedClipSelections(
  clips: readonly unknown[],
  lookup: ElementLookup,
  map: ReadonlyMap<string, string>,
): readonly unknown[] {
  let changed = false
  const next = clips.map((clip) => {
    if (!clip || typeof clip !== 'object') return clip
    const segment = (clip as { segment?: unknown }).segment
    if (!isVideoSegment(segment)) return clip
    const verified = withVerifiedLocalSelection(segment, lookup, map)
    if (verified === segment) return clip
    changed = true
    return { ...(clip as Record<string, unknown>), segment: verified }
  })
  return changed ? next : clips
}

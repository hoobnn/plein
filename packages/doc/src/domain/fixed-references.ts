import type { CanvasElement, NodeResult } from '../types'
import { isGenerationOrigin, type GenerationOrigin } from './video-segment'
import { sequenceInstancesOf } from './sequence-instances'

/**
 * 固定剪辑对某个节点的引用。
 *
 * 固定下来的视频片段记着它当时选中的候选身份（`selection`）。
 * 候选被 48 条窗口裁掉时，这些片段仍要能找到原候选返工，所以裁剪必须先并集保护它们。
 *
 * 身份是完整的一组：画布、节点、端口、候选、运行，外加当时的视频文件。
 * 少了任何一项都不能算「指向本节点的这个候选」——
 * 复制出来的画布可能有同名节点甚至相同候选 id，只有完整身份才对得上。
 */
export interface FixedResultReference {
  /** 被引用候选所在节点的画布 */
  canvasId: string
  /** 被引用的节点 id */
  nodeId: string
  /** 被引用的输出端口 */
  port: string
  /** 被引用的候选 id */
  resultId: string
  /** 被引用候选的那次运行 */
  runId: string
  /** 固定时选中的视频文件 */
  assetId: string
  /** 引用所在的节点（固定素材卡或序列实例所在元素） */
  holderId: string
  /** 固定片段 id */
  segmentId: string
  /** 序列实例 id（素材卡没有） */
  clipInstanceId?: string
}

function collect(element: CanvasElement, out: FixedResultReference[]) {
  const segment = element.videoSegment
  if (segment?.selection && isGenerationOrigin(segment.selection))
    out.push(reference(element.id, segment.segmentId, segment.selection, segment.asset.assetId))
  if (element.nodeType !== 'plein/sequence') return
  for (const clip of sequenceInstancesOf(element)) {
    const selection = clip.segment?.selection
    if (selection && isGenerationOrigin(selection))
      out.push(
        reference(
          element.id,
          clip.segment!.segmentId,
          selection,
          clip.segment!.asset.assetId,
          clip.clipInstanceId,
        ),
      )
  }
}

function reference(
  holderId: string,
  segmentId: string,
  selection: GenerationOrigin,
  assetId: string,
  clipInstanceId?: string,
): FixedResultReference {
  return {
    canvasId: selection.canvasId,
    nodeId: selection.nodeId,
    port: selection.port,
    resultId: selection.resultId,
    runId: selection.runId,
    assetId,
    holderId,
    segmentId,
    ...(clipInstanceId ? { clipInstanceId } : {}),
  }
}

/**
 * 画布里所有指向候选的固定引用。
 *
 * 只认精确的 `selection`（画布 / 节点 / 端口 / 候选 / 运行），
 * 不按素材 hash 或名称猜来源。
 */
export function fixedResultReferences(elements: Iterable<CanvasElement>): FixedResultReference[] {
  const out: FixedResultReference[] = []
  for (const element of elements) collect(element, out)
  return out
}

/**
 * 某个节点的候选里，被本画布的固定剪辑精确引用的那些。
 *
 * 完整核对身份：画布、节点、端口、候选、运行，以及当时固定的那个视频文件。
 * 任一项对不上就不算引用 —— 同名节点、相同候选 id、不同文件都不能蒙混。
 */
export function fixedReferencedResultIds(
  elements: Iterable<CanvasElement>,
  scope: { canvasId: string; nodeId: string; results: readonly NodeResult[] },
): Set<string> {
  const ids = new Set<string>()
  const byId = new Map(scope.results.map((r) => [r.id, r]))
  for (const reference of fixedResultReferences(elements)) {
    if (reference.canvasId !== scope.canvasId) continue
    if (reference.nodeId !== scope.nodeId) continue
    const result = byId.get(reference.resultId)
    if (!result) continue
    if (result.port !== reference.port) continue
    if (result.runId !== reference.runId) continue
    // 固定的是哪个文件，就必须是哪个文件
    if ('assetId' in result.value && result.value.assetId !== reference.assetId) continue
    ids.add(result.id)
  }
  return ids
}

/**
 * 候选的关联输出：同一次运行里按已有规则配对的其它端口结果。
 *
 * 有 `outputGroup` 的按关联键取；旧记录没有关联键时，用 `relatedResult`
 * 的唯一跨端口配对规则（不猜第一条）。
 */
export function relatedOutputIds(results: readonly NodeResult[], resultId: string): Set<string> {
  const ids = new Set<string>()
  const chosen = results.find((r) => r.id === resultId)
  if (!chosen) return ids
  ids.add(chosen.id)
  if (chosen.outputGroup !== undefined) {
    for (const r of results) {
      if (r.runId !== chosen.runId) continue
      if (r.outputGroup !== chosen.outputGroup) continue
      ids.add(r.id)
    }
    return ids
  }
  // 旧记录没有关联键：同一次运行里，与所选端口唯一配对的那个就是关联输出。
  const ports = new Set(results.filter((r) => r.runId === chosen.runId).map((r) => r.port))
  for (const port of ports) {
    if (port === chosen.port) continue
    const candidates = results.filter(
      (r) => r.runId === chosen.runId && r.port === port && r.outputGroup === undefined,
    )
    const atChosenPort = results.filter(
      (r) => r.runId === chosen.runId && r.port === chosen.port && r.outputGroup === undefined,
    )
    if (candidates.length === 1 && atChosenPort.length === 1) ids.add(candidates[0]!.id)
  }
  return ids
}

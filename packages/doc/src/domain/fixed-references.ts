import type { CanvasElement, NodeResult } from '../types'
import { isGenerationOrigin, type GenerationOrigin, type VideoSegment } from './video-segment'
import { sequenceInstancesOf } from './sequence-instances'
import { relatedResult } from './related-result'

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
  if (segment) {
    for (const selection of selectionsOf(segment)) {
      if (isGenerationOrigin(selection))
        out.push(reference(element.id, segment.segmentId, selection, segment.asset.assetId))
    }
  }
  if (element.nodeType !== 'plein/sequence') return
  for (const clip of sequenceInstancesOf(element)) {
    const segment = clip.segment
    if (!segment) continue
    for (const selection of selectionsOf(segment)) {
      if (isGenerationOrigin(selection))
        out.push(
          reference(
            element.id,
            segment.segmentId,
            selection,
            segment.asset.assetId,
            clip.clipInstanceId,
          ),
        )
    }
  }
}

/**
 * 片段记着的历史位置与导入后核实过的本地位置都要算引用。
 * 历史位置证明它来自哪次生成；本地位置是当前画布里该保护的候选。
 */
function selectionsOf(segment: VideoSegment): Array<GenerationOrigin | undefined> {
  const out: Array<GenerationOrigin | undefined> = [segment.selection]
  const local = segment.localSelection
  if (local && (!segment.selection || JSON.stringify(local) !== JSON.stringify(segment.selection)))
    out.push(local)
  return out
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
  return new Set(fixedResultHolders(elements, scope).keys())
}

/**
 * 某个节点的哪些候选正被本画布的固定剪辑使用，以及是谁在用。
 *
 * 手工删除、Agent / MCP 删除都要先说清楚哪些片段还靠着它，不能静默删掉。
 */
export function fixedResultHolders(
  elements: Iterable<CanvasElement>,
  scope: { canvasId: string; nodeId: string; results: readonly NodeResult[] },
): Map<string, FixedResultReference[]> {
  const out = new Map<string, FixedResultReference[]>()
  const byId = new Map(scope.results.map((r) => [r.id, r]))
  for (const reference of fixedResultReferences(elements)) {
    if (reference.canvasId !== scope.canvasId) continue
    if (reference.nodeId !== scope.nodeId) continue
    const result = byId.get(reference.resultId)
    if (!result) continue
    if (result.port !== reference.port) continue
    if (result.runId !== reference.runId) continue
    // 必须是同一条视频候选、同一个文件；同样 id/运行/端口的文本记录不能算
    if (result.value.type !== 'video' || result.value.assetId !== reference.assetId) continue
    const list = out.get(reference.resultId) ?? []
    if (!list.some((r) => r.holderId === reference.holderId && r.segmentId === reference.segmentId))
      list.push(reference)
    out.set(reference.resultId, list)
  }
  return out
}

/**
 * 候选的关联输出：候选本身，加上每个其它端口按既有 `relatedResult` 规则
 * 唯一配对到的那一条。
 *
 * 不能按「同一次运行 + 同 outputGroup」把同端口的其它候选也算进来：
 * 同一组里有两个视频候选时，尾帧根本配不上任何一条，真实返工也取不到它；
 * 旧数据里同一运行既有不带关联键的旧视频、又有带组的视频时，跨端口也不是唯一配对。
 * 删除保护、48 条裁剪与 current 项目包都用这一份规则，避免这边多保护、那边取不到。
 */
export function relatedOutputIds(results: readonly NodeResult[], resultId: string): Set<string> {
  const ids = new Set<string>()
  const chosen = results.find((r) => r.id === resultId)
  if (!chosen) return ids
  ids.add(chosen.id)
  for (const port of new Set(results.map((r) => r.port))) {
    if (port === chosen.port) continue
    const related = relatedResult(results, chosen, port)
    if (related) ids.add(related.id)
  }
  return ids
}

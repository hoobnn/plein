import type { Engine } from '@plein/canvas-core'
import { adoptResult, currentResult, type NodeResult } from '@plein/doc'
import { useCanvas } from '../stores/canvas'

type View = NonNullable<ReturnType<typeof useCanvas.getState>['viewer']>
export interface ReviewActionTarget {
  engine: Engine | null
  canvasId: string | null
  viewer: View
  result?: NodeResult
}

export function isCurrentReview(target: ReviewActionTarget) {
  const current = useCanvas.getState()
  return (
    current.engine === target.engine &&
    current.canvasId === target.canvasId &&
    current.viewer === target.viewer
  )
}

/** 按钮与键盘共用实时校验，拒绝旧浮层、旧来源或内容已变化的候选。 */
export function runReviewAction(
  target: ReviewActionTarget,
  action: 'adopt' | 'locate',
): string | null {
  const operation = action === 'adopt' ? '采用' : '定位'
  if (!isCurrentReview(target)) return `审片上下文已变化，本次${operation}未执行`
  const engine = target.engine
  const node = engine && target.viewer.nodeId ? engine.doc.get(target.viewer.nodeId) : undefined
  if (!engine || !node) return `来源节点已删除，本次${operation}未执行`
  if (action === 'locate') {
    useCanvas.getState().toggleHistory(false)
    engine.selection.set([node.id])
    engine.zoomToFit([node.id])
    return null
  }
  if (engine.doc.readOnly) return '画布已变为只读，本次采用未执行'
  const expected = target.result
  const latest = node.results?.find((result) => result.id === expected?.id)
  const identity = (result: NodeResult) => JSON.stringify([result.runId, result.port, result.value])
  if (!expected || !latest || identity(expected) !== identity(latest))
    return '候选已变化，本次采用未执行；请确认当前候选后重试'
  if (currentResult(node, latest.port)?.id === latest.id) return null
  engine.doc.undo.stopCapturing()
  adoptResult(engine.doc, node.id, latest.id)
  engine.doc.undo.stopCapturing()
  return null
}

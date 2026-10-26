import type { Engine } from '@plein/canvas-core'
import type { ObservationEvidence, StateField } from '@plein/doc'
import { useCanvas } from '../../stores/canvas'
import { useSession } from '../../stores/session'

export const stateLabels: Record<StateField, string> = {
  worldPosition: '世界位置',
  screenPosition: '画面位置',
  pose: '姿态',
  holder: '持有者与手',
  condition: '状态 / 完好程度',
}
export const certaintyLabels = {
  observed: '观察到',
  unknown: '无法判断',
  inferred: '推测',
} as const
export function continuityWriteContext(
  engine: Engine,
  canvasId: string,
  boardId: string,
  isCurrent?: () => boolean,
) {
  const state = useCanvas.getState()
  const principal = useSession.getState().info?.principal
  return !engine.doc.readOnly &&
    !engine.doc.ydoc.isDestroyed &&
    state.engine === engine &&
    state.canvasId === canvasId &&
    (isCurrent ? isCurrent() : state.storyboard === boardId) &&
    principal &&
    principal.role !== 'viewer' &&
    engine.doc.get(boardId)?.nodeType === 'plein/storyboard'
    ? principal.id
    : undefined
}
export interface ContinuityPlayback {
  assetId: string
  start: number
  end: number
  duration: number
  audible: boolean
}
export function observationEvidenceLabel(evidence: ObservationEvidence): string {
  if (evidence.kind === 'frame')
    return evidence.position === 'end'
      ? '末帧视觉样本（last=true，不声明精确PTS）'
      : evidence.position === 'start'
        ? '首帧视觉样本'
        : `${evidence.position.at.toFixed(3)}秒请求点视觉样本`
  return `${evidence.start.toFixed(3)}–${evidence.end.toFixed(3)}秒 · ${evidence.aspects.map((a) => ({ visual: '视觉', motion: '动作回看', sound: '声音回听' })[a]).join('、')}`
}

import type { Engine } from '@plein/canvas-core'
import {
  continuityOf,
  creativeReviewKey,
  currentContinuityObservations,
  currentResult,
  currentShotPlan,
  type CanvasElement,
  type StateField,
} from '@plein/doc'
import type { Shot } from '@plein/nodes'
import { assetUrls } from '../../api/client'
import { ContinuityNoteForm, type ContinuityNoteView } from './ContinuityNoteForm'
import { stateLabels, stateValueText } from './continuityModel'
import type { ShotSource } from './model'

export function ShotComparison({
  engine,
  canvasId,
  boardId,
  previous,
  shot,
  groups,
  onReview,
  canReview,
  candidatePrimary,
  continuity,
  writable,
  onSwitchStage,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  previous: Shot | undefined
  shot: Shot
  groups: Map<string, CanvasElement[]>
  onReview(): void
  canReview: boolean
  candidatePrimary: boolean
  continuity: {
    node: CanvasElement | undefined
    view: ContinuityNoteView
  }
  writable(): boolean
  onSwitchStage(): void
}) {
  const record = continuityOf(engine.doc, boardId)
  // 第一镜没有可对照的内容，只留一行，不占版面
  if (!previous)
    return (
      <section className="space-y-2" aria-label="上一镜结束到本镜开始">
        <h3 className="font-medium">上一镜结束 → 本镜开始</h3>
        <p className="text-xs text-ink-subtle">第一镜，无需对照</p>
      </section>
    )
  const side = (item: Shot | undefined, phase: 'start' | 'end') => {
    if (!item) return <p>没有上一镜</p>
    const currents = currentContinuityObservations(engine.doc, { canvasId, boardId }, item.id)
    const observation = currents.find(
      (o) => o.phase === phase && o.evidence.kind === 'frame' && o.evidence.position === phase,
    )
    const video = (groups.get(item.id) ?? []).find(
      (n) => (n.params?.source as ShotSource)?.role === 'video',
    )
    const tail =
      phase === 'end' && video && currentResult(video)?.value.type === 'video'
        ? currentResult(video, 'lastFrame')?.value
        : undefined
    const frame =
      tail?.type === 'image'
        ? tail.assetId
        : observation?.evidence.kind === 'frame' && observation.evidence.position === phase
          ? observation.evidence.frameAssetId
          : undefined
    const imageNode = (groups.get(item.id) ?? []).find(
      (n) => (n.params?.source as ShotSource)?.role === 'image',
    )
    const image = imageNode && currentResult(imageNode)?.value
    const imageId = frame ?? (image?.type === 'image' ? image.assetId : undefined)
    const frameLabel =
      tail?.type === 'image' || observation?.target.kind === 'video'
        ? phase === 'end'
          ? '视频末帧'
          : '视频首帧'
        : '候选观察画面'
    const plan = currentShotPlan(record, item.id)
    const states = plan.plan?.content[phase]
    // 观察绑定在具体候选上；其余失效（计划、主体、历史迁移）也一律提醒重新审阅
    const phaseCurrents = currents.filter((o) => o.phase === phase)
    const outdated =
      !phaseCurrents.length &&
      record.observations.some(
        (o) =>
          o.shotId === item.id &&
          o.phase === phase &&
          !o.historical &&
          o.scope.canvasId === canvasId &&
          !currents.some((c) => c.id === o.id),
      )
    return (
      <div className="space-y-1">
        <p className="font-medium">
          镜头 {item.no} · {phase === 'end' ? '结束' : '开始'}
        </p>
        {imageId ? (
          <img
            src={assetUrls.original(imageId)}
            alt={frame ? frameLabel : '分镜图'}
            className="h-36 w-full rounded-lg bg-black object-contain"
          />
        ) : (
          <p>画面未知</p>
        )}
        <p className="text-xs">{frame ? frameLabel : imageId ? '来源：分镜图' : ''}</p>
        {plan.state === 'conflict' ? (
          <p>计划版本冲突，请核对</p>
        ) : states && Object.keys(states).length ? (
          Object.entries(states).map(([id, fields]) => (
            <p key={id} className="text-xs">
              {record.subjects.find((subject) => subject.id === id)?.label ?? id} ·{' '}
              {Object.entries(fields)
                .map(
                  ([field, value]) =>
                    `${stateLabels[field as StateField]}：${stateValueText(field as StateField, value, record.subjects)}`,
                )
                .join(' · ')}
            </p>
          ))
        ) : (
          <p className="text-xs">状态未知</p>
        )}
        {phaseCurrents.length ? (
          <p className="text-xs text-success">已记录 {phaseCurrents.length} 条衔接观察</p>
        ) : outdated ? (
          <p className="text-xs text-warning">旧观察已失效，请重新审阅</p>
        ) : null}
      </div>
    )
  }
  return (
    <section className="space-y-2" aria-label="上一镜结束到本镜开始">
      <h3 className="font-medium">上一镜结束 → 本镜开始</h3>
      <div className="grid grid-cols-2 gap-3">
        {side(previous, 'end')}
        {side(shot, 'start')}
      </div>
      <ContinuityNoteForm
        key={`${continuity.view.target ? creativeReviewKey(continuity.view.target) : 'none'}/${continuity.view.targetReview?.at ?? 0}`}
        doc={engine.doc}
        node={continuity.node}
        view={continuity.view}
        writable={writable}
        primary={!candidatePrimary}
        canReview={canReview}
        onReview={onReview}
        onSwitchStage={onSwitchStage}
      />
    </section>
  )
}

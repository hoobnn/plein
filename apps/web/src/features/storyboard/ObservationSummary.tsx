import type { Engine } from '@plein/canvas-core'
import { continuityOf, currentContinuityObservations, type StateField } from '@plein/doc'
import { certaintyLabels, observationEvidenceLabel, stateLabels } from './continuityModel'

export function ObservationSummary({
  engine,
  canvasId,
  boardId,
  shotId,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
}) {
  const record = continuityOf(engine.doc, boardId),
    current = currentContinuityObservations(engine.doc, { canvasId, boardId }, shotId)
  const history = record.observations.filter(
    (o) => o.shotId === shotId && !current.some((c) => c.id === o.id),
  )
  const lines = (states: (typeof current)[number]['states']) =>
    Object.entries(states).flatMap(([id, fields]) =>
      Object.entries(fields).map(([field, value]) => {
        if (!value) return `${stateLabels[field as StateField]}：未检查`
        let detail = value.note ?? ''
        if (value.certainty !== 'unknown') {
          const actual = value.value
          detail =
            typeof actual === 'string'
              ? actual
              : `${record.subjects.find((s) => s.id === actual.subjectId)?.label ?? '历史角色'} · ${{ right: '右手', left: '左手', both: '双手' }[actual.hand]}`
        }
        return `${record.subjects.find((s) => s.id === id)?.label ?? '历史主体'} · ${stateLabels[field as StateField]}：${certaintyLabels[value.certainty]} ${detail}`
      }),
    )
  return (
    <div className="space-y-2 p-2 text-xs">
      <p>观察独立于计划和创作验收；静帧只说明所见范围。</p>
      {!current.length && <p>当前候选尚无独立观察，保持未检查。</p>}
      {current.map((o) => (
        <div key={o.id}>
          <p>
            {o.phase === 'start' ? '起始' : '结束'} · {observationEvidenceLabel(o.evidence)}
          </p>
          {lines(o.states).map((text) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      ))}
      {!!history.length && (
        <details>
          <summary>历史观察（{history.length}），不作为当前候选结论</summary>
          {history.map((o) => (
            <p key={o.id}>
              {o.target.resultId?.slice(-10) ?? o.target.assetId.slice(0, 12)} ·{' '}
              {observationEvidenceLabel(o.evidence)}
            </p>
          ))}
        </details>
      )}
    </div>
  )
}

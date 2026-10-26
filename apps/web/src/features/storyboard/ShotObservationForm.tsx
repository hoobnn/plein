import type { Engine } from '@plein/canvas-core'
import {
  continuityOf,
  creativeReviewKey,
  creativeReviewTarget,
  currentContinuityObservations,
  currentShotPlan,
  recordContinuityObservation,
  STATE_FIELDS,
  type CanvasElement,
  type ObservedValue,
  type ObservationEvidence,
  type StateField,
} from '@plein/doc'
import { useState } from 'react'
import { useDocVersion } from '../../canvas/hooks'
import { useSession } from '../../stores/session'
import {
  certaintyLabels,
  continuityWriteContext,
  observationEvidenceLabel,
  stateLabels,
  type ContinuityPlayback,
} from './continuityModel'

/** 只记录当前候选的检查范围和独立观察，不修改计划或创作验收结论。 */
export function ShotObservationForm({
  engine,
  canvasId,
  boardId,
  shotId,
  phase,
  node,
  frameAssetId,
  playback,
  isCurrent,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
  phase: 'start' | 'end'
  node: CanvasElement
  frameAssetId?: string
  playback?: ContinuityPlayback
  isCurrent?(): boolean
}) {
  useDocVersion(engine.doc)
  useSession((s) => s.info?.principal)
  const record = continuityOf(engine.doc, boardId)
  const target = creativeReviewTarget(node)
  const [element] = useState(() => engine.doc.elementMaps.get(node.id))
  const [subjectId, setSubjectId] = useState(record.subjects[0]?.id ?? '')
  const [field, setField] = useState<StateField>('condition')
  const [certainty, setCertainty] = useState<ObservedValue['certainty']>('unknown')
  const [value, setValue] = useState('')
  const [holderId, setHolderId] = useState('')
  const [hand, setHand] = useState<'left' | 'right' | 'both'>('right')
  const [note, setNote] = useState('')
  const [mode, setMode] = useState<'frame' | 'interval'>('frame')
  const [aspects, setAspects] = useState<Array<'visual' | 'motion' | 'sound'>>(['visual'])
  const [declared, setDeclared] = useState(false)
  const [error, setError] = useState('')
  const subject = record.subjects.find((s) => s.id === subjectId)
  const writable = !!continuityWriteContext(engine, canvasId, boardId, isCurrent)
  const played = target && playback?.assetId === target.assetId ? playback : undefined
  const current = target
    ? currentContinuityObservations(engine.doc, { canvasId, boardId }, shotId, phase).filter(
        (o) => o.nodeId === node.id && creativeReviewKey(o.target) === creativeReviewKey(target),
      )
    : []
  const history = record.observations.filter(
    (o) => o.shotId === shotId && o.phase === phase && !current.some((c) => c.id === o.id),
  )
  if (!target) return <p className="text-sm">当前没有可绑定的候选，观察保持未检查。</p>
  const frame = frameAssetId ?? (target.kind === 'image' ? target.assetId : undefined)
  const canSave =
    writable &&
    !!subject &&
    (certainty === 'unknown' || (field === 'holder' ? !!holderId : !!value.trim())) &&
    (mode === 'frame'
      ? !!frame && target.kind !== 'audio'
      : !!played && declared && aspects.length > 0)
  return (
    <section
      aria-label={`${phase === 'start' ? '起始' : '结束'}候选观察`}
      className="space-y-2 rounded-lg border border-line p-3 text-sm"
    >
      <h3 className="font-medium">{phase === 'start' ? '起始' : '结束'}候选观察</h3>
      <p className="text-xs text-ink-subtle">
        候选 {target.resultId?.slice(-8) ?? target.assetId.slice(0, 8)}
        。未填写表示未检查；无法判断和推测均不代表已核验，不写回计划或“可用”结论。
      </p>
      {!record.subjects.length && <p>先在“镜头目的与起止计划”中添加需要观察的主体。</p>}
      <fieldset disabled={!writable} className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <select
            aria-label={`${phase === 'start' ? '起始' : '结束'}观察主体`}
            className="ui-input"
            value={subject?.id ?? ''}
            onChange={(e) => {
              setSubjectId(e.target.value)
              setField('condition')
            }}
          >
            <option value="">选择主体</option>
            {record.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {s.id.slice(-6)}
              </option>
            ))}
          </select>
          <select
            aria-label={`${phase === 'start' ? '起始' : '结束'}观察字段`}
            className="ui-input"
            value={field}
            onChange={(e) => setField(e.target.value as StateField)}
          >
            {STATE_FIELDS.filter((f) => f !== 'holder' || subject?.kind === 'prop').map((f) => (
              <option key={f} value={f}>
                {stateLabels[f]}
              </option>
            ))}
          </select>
          <select
            aria-label={`${phase === 'start' ? '起始' : '结束'}观察确定性`}
            className="ui-input"
            value={certainty}
            onChange={(e) => setCertainty(e.target.value as ObservedValue['certainty'])}
          >
            {Object.entries(certaintyLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {certainty !== 'unknown' &&
          (field === 'holder' ? (
            <div className="flex gap-2">
              <select
                aria-label={`${phase === 'start' ? '起始' : '结束'}观察持有者`}
                className="ui-input"
                value={holderId}
                onChange={(e) => setHolderId(e.target.value)}
              >
                <option value="">选择确切角色</option>
                {record.subjects
                  .filter((s) => s.kind === 'character')
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label} · {s.id.slice(-6)}
                    </option>
                  ))}
              </select>
              <select
                aria-label={`${phase === 'start' ? '起始' : '结束'}观察持物手`}
                className="ui-input"
                value={hand}
                onChange={(e) => setHand(e.target.value as typeof hand)}
              >
                <option value="right">右手</option>
                <option value="left">左手</option>
                <option value="both">双手</option>
              </select>
            </div>
          ) : (
            <input
              aria-label={`${phase === 'start' ? '起始' : '结束'}观察值`}
              className="ui-input w-full"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ))}
        <textarea
          aria-label={`${phase === 'start' ? '起始' : '结束'}观察备注`}
          className="ui-input w-full"
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            certainty === 'unknown'
              ? '说明遮挡、画面不足或其他无法判断原因'
              : '说明具体依据；推测不会成为剧情事实'
          }
        />
        <select
          aria-label={`${phase === 'start' ? '起始' : '结束'}检查范围`}
          className="ui-input"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as typeof mode)
            setDeclared(false)
          }}
        >
          <option value="frame">{phase === 'start' ? '首帧' : '末帧'}视觉检查</option>
          <option value="interval" disabled={!played || target.kind === 'image'}>
            实际回放区间
          </option>
        </select>
        {mode === 'frame' ? (
          <p className="text-xs text-ink-subtle">
            记录实际派生{phase === 'start' ? '首帧' : '末帧'}
            ，不编造精确时间点；静帧不能记录完整动作或声音已检查。
          </p>
        ) : (
          played && (
            <div className="space-y-2">
              <p className="text-xs text-ink-subtle">
                已回放 {played.start.toFixed(3)}–{played.end.toFixed(3)} 秒，仅声明这段范围。
              </p>
              <div className="flex gap-3">
                {(['visual', 'motion', 'sound'] as const).map((aspect) => (
                  <label key={aspect}>
                    <input
                      type="checkbox"
                      disabled={aspect === 'sound' && !played.audible}
                      checked={aspects.includes(aspect)}
                      onChange={(e) =>
                        setAspects(
                          e.target.checked
                            ? [...aspects, aspect]
                            : aspects.filter((a) => a !== aspect),
                        )
                      }
                    />
                    {{ visual: '视觉', motion: '动作回看', sound: '声音回听' }[aspect]}
                  </label>
                ))}
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={declared}
                  onChange={(e) => setDeclared(e.target.checked)}
                />
                我已在所示回放区间检查所选项目；未知和推测仍保留
              </label>
            </div>
          )
        )}
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          disabled={!canSave}
          onClick={() => {
            const userId = continuityWriteContext(engine, canvasId, boardId, isCurrent)
            if (!userId || !subject || engine.doc.elementMaps.get(node.id) !== element) {
              setError('当前不可写或候选来源已变化')
              return
            }
            let evidence: ObservationEvidence
            if (mode === 'frame') {
              if (!frame) return
              evidence = {
                kind: 'frame',
                position: phase,
                frameAssetId: frame,
                aspects: ['visual'],
              }
            } else {
              if (!played || !declared) return
              evidence = {
                kind: 'interval',
                start: played.start,
                end: played.end,
                duration: played.duration,
                playback: { completed: true, audible: played.audible },
                declared: true,
                aspects: [...aspects],
              }
            }
            const observation: ObservedValue =
              certainty === 'unknown'
                ? { certainty, note }
                : {
                    certainty,
                    value: field === 'holder' ? { subjectId: holderId, hand } : value,
                    note,
                  }
            const basis = currentShotPlan(record, shotId).plan
            const saved = recordContinuityObservation(engine.doc, {
              scope: { canvasId, boardId },
              shotId,
              phase,
              nodeId: node.id,
              target,
              evidence,
              states: { [subject.id]: { [field]: observation } },
              ...(basis ? { basisPlanRevisionId: basis.id } : {}),
              origin: { kind: 'manual', userId },
            })
            setError(saved ? '' : '候选、计划或检查范围已变化，本次观察未保存')
          }}
        >
          保存独立观察
        </button>
      </fieldset>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <ul
        aria-label={`${phase === 'start' ? '起始' : '结束'}当前候选观察`}
        className="space-y-1 text-xs"
      >
        {current.map((o) => (
          <li key={o.id}>
            {observationEvidenceLabel(o.evidence)} ·{' '}
            {Object.entries(o.states)
              .flatMap(([id, fields]) =>
                Object.entries(fields).map(
                  ([key, v]) =>
                    `${record.subjects.find((s) => s.id === id)?.label ?? '历史主体'} ${stateLabels[key as StateField]}：${v ? certaintyLabels[v.certainty] : '未检查'}${v?.certainty === 'unknown' ? `（${v.note || '无法判断'}）` : v && typeof v.value === 'string' ? ` ${v.value}` : ''}`,
                ),
              )
              .join('；')}{' '}
            · {o.origin.kind === 'manual' ? '人工声明' : '工具推测'}
          </li>
        ))}
      </ul>
      {!!history.length && (
        <details className="text-xs text-ink-subtle">
          <summary>历史候选观察（{history.length}）</summary>
          {history.map((o) => (
            <p key={o.id}>
              {o.target.resultId?.slice(-8) ?? o.target.assetId.slice(0, 8)} ·
              历史记录，不充当当前候选观察
            </p>
          ))}
        </details>
      )}
    </section>
  )
}

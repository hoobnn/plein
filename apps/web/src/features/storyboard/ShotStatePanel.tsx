import type { Engine } from '@plein/canvas-core'
import {
  appendShotPlan,
  continuityDependencies,
  continuityOf,
  currentShotPlan,
  emptyShotPlan,
  registerContinuitySubject,
  resolvedShotState,
  STATE_FIELDS,
  type EntityState,
  type ShotPlanContent,
  type ShotPlanRevision,
  type StateField,
} from '@plein/doc'
import { useState } from 'react'
import { useDocVersion } from '../../canvas/hooks'
import { useSession } from '../../stores/session'
import { Modal, ModalHeader } from '../../ui/Modal'
import { shotsOf } from './model'
import { continuityWriteContext, stateLabels } from './continuityModel'

const button = 'ui-btn ui-btn-secondary'
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
export function ShotStatePanel(props: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
  onClose(): void
}) {
  return (
    <Modal top label="镜头目的与起止计划" onClose={props.onClose} className="max-w-240">
      <ModalHeader title="镜头目的与起止计划" onClose={props.onClose} />
      <ShotPlanForm {...props} />
    </Modal>
  )
}

/** P07 复用该表单及 doc helper，不再维护另一份镜头目的或状态。 */
export function ShotPlanForm({
  engine,
  canvasId,
  boardId,
  shotId,
  isCurrent,
}: {
  engine: Engine
  canvasId: string
  boardId: string
  shotId: string
  isCurrent?(): boolean
}) {
  useDocVersion(engine.doc)
  useSession((s) => s.info?.principal)
  const record = continuityOf(engine.doc, boardId)
  const current = currentShotPlan(record, shotId)
  const shots = shotsOf(engine.doc.get(boardId))
  const shot = shots.find((s) => s.id === shotId)
  const [element] = useState(() => engine.doc.elementMaps.get(boardId))
  const [heads, setHeads] = useState(() => current.heads.map((p) => p.id))
  const [draft, setDraft] = useState<ShotPlanContent>(() =>
    copy(current.plan?.content ?? emptyShotPlan()),
  )
  const [subjectId, setSubjectId] = useState(record.subjects[0]?.id ?? '')
  const [label, setLabel] = useState('')
  const [subjectKind, setSubjectKind] = useState<'character' | 'scene' | 'prop'>('character')
  const [bindingId, setBindingId] = useState('')
  const [inheritPlanId, setInheritPlanId] = useState('')
  const [inheritFields, setInheritFields] = useState<StateField[]>([])
  const [branch, setBranch] = useState('')
  const [error, setError] = useState('')
  const writable = !!continuityWriteContext(engine, canvasId, boardId, isCurrent)
  const changed =
    JSON.stringify([...heads].sort()) !== JSON.stringify(current.heads.map((p) => p.id).sort())
  const subject = record.subjects.find((s) => s.id === subjectId)
  const resolved = resolvedShotState(record, {
    id: 'draft',
    shotId,
    parents: heads,
    content: draft,
    userId: '',
    at: 0,
    originAtCapture: { canvasId, boardId },
  })
  const linked = (field: StateField) =>
    draft.inherits.some((r) => r.subjectId === subject?.id && r.fields.includes(field))
  const change = (
    phase: 'start' | 'end',
    field: StateField,
    value: EntityState[StateField] | undefined,
  ) => {
    if (!subject) return
    setDraft((old) => {
      const next = copy(old)
      next[phase][subject.id] ??= {}
      if (value === undefined || value === '') delete next[phase][subject.id]![field]
      else Object.assign(next[phase][subject.id]!, { [field]: value })
      return next
    })
  }
  const guard = () =>
    engine.doc.elementMaps.get(boardId) === element
      ? continuityWriteContext(engine, canvasId, boardId, isCurrent)
      : undefined
  const load = (plan?: ShotPlanRevision) => {
    setDraft(copy(plan?.content ?? emptyShotPlan()))
    setHeads(current.heads.map((p) => p.id))
    setError('')
  }
  return (
    <section aria-label="镜头计划状态" className="min-h-0 overflow-y-auto p-5 space-y-4">
      <p className="text-sm text-ink-subtle">
        镜头 {shot?.no ?? '（已删除）'}
        。所有状态均可留空；世界位置与画面位置分别填写。计划不会自动改写提示词、观察或候选。
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {changed && (
        <p role="status" className="text-sm text-warning">
          计划已有其他修订，当前草稿仍保留；请载入当前计划后再保存。
        </p>
      )}
      {current.state === 'conflict' && (
        <div className="text-sm">
          <p role="alert">存在协作分支，请明确选择内容并保存合并版本。</p>
          <select
            aria-label="计划协作分支"
            className="ui-input"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">选择分支</option>
            {current.heads.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id.slice(-8)} · {p.userId} · {p.content.intent || '未填目的'}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={button}
            disabled={!current.heads.some((p) => p.id === branch)}
            onClick={() => {
              const head = current.heads.find((p) => p.id === branch)
              if (head) load(head)
              else setError('所选分支已变化，请重新选择')
            }}
          >
            以所选分支准备合并
          </button>
        </div>
      )}
      {current.state !== 'conflict' && (
        <button type="button" className={button} onClick={() => load(current.plan)}>
          载入当前计划
        </button>
      )}
      <label className="block text-sm">
        镜头目的
        <textarea
          aria-label="镜头目的"
          className="ui-input w-full"
          maxLength={2000}
          disabled={!writable}
          value={draft.intent ?? ''}
          onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
          placeholder="这一个镜头承担什么叙事作用"
        />
      </label>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label>
          状态主体
          <select
            aria-label="状态主体"
            className="ui-input"
            value={subject?.id ?? ''}
            onChange={(e) => {
              setSubjectId(e.target.value)
              setInheritFields([])
            }}
          >
            <option value="">请选择</option>
            {record.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {{ character: '角色', scene: '场景', prop: '道具' }[s.kind]} ·{' '}
                {s.id.slice(-6)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-ink-subtle">
          {subject?.binding?.elementId
            ? engine.doc.get(subject.binding.elementId)
              ? '已明确绑定画布资产'
              : '原绑定已缺失，不按名称重连'
            : subject?.binding?.libraryId
              ? '已明确绑定资产库条目'
              : '未绑定：独立主体身份'}
        </span>
      </div>
      <details className="rounded-lg border border-line p-3 text-sm">
        <summary>添加可选主体</summary>
        <div className="mt-2 flex flex-wrap gap-2">
          <select
            aria-label="主体类型"
            className="ui-input"
            value={subjectKind}
            disabled={!writable}
            onChange={(e) => {
              setSubjectKind(e.target.value as typeof subjectKind)
              setBindingId('')
            }}
          >
            <option value="character">角色</option>
            <option value="scene">场景</option>
            <option value="prop">道具</option>
          </select>
          <input
            aria-label="主体名称"
            className="ui-input"
            value={label}
            disabled={!writable}
            onChange={(e) => setLabel(e.target.value)}
          />
          <select
            aria-label="主体明确绑定"
            className="ui-input"
            value={bindingId}
            disabled={!writable}
            onChange={(e) => {
              setBindingId(e.target.value)
              if (e.target.value) setLabel(engine.doc.get(e.target.value)?.name ?? '')
            }}
          >
            <option value="">不绑定，不按名称推断</option>
            {[...engine.doc.elements()]
              .filter((el) => el.nodeType === `plein/${subjectKind}`)
              .map((el) => (
                <option key={el.id} value={el.id}>
                  {el.name ?? subjectKind} · {el.id.slice(-6)}
                </option>
              ))}
          </select>
          <button
            type="button"
            className={button}
            disabled={!writable || !label.trim()}
            onClick={() => {
              if (!guard()) {
                setError('当前不可写或已切换目标')
                return
              }
              const node = bindingId ? engine.doc.get(bindingId) : undefined
              const libraryId = node?.params?.libraryId
              const id = registerContinuitySubject(engine.doc, {
                scope: { canvasId, boardId },
                kind: subjectKind,
                label,
                binding: bindingId
                  ? {
                      elementId: bindingId,
                      ...(typeof libraryId === 'string' ? { libraryId } : {}),
                    }
                  : null,
              })
              if (id) {
                setSubjectId(id)
                setLabel('')
                setError('')
              } else setError('主体来源已变化，请重新选择')
            }}
          >
            添加主体
          </button>
        </div>
      </details>
      {subject && (
        <div className="grid gap-4 md:grid-cols-2">
          {(['start', 'end'] as const).map((phase) => (
            <fieldset
              key={phase}
              className="space-y-2 rounded-lg border border-line p-3"
              disabled={!writable}
            >
              <legend className="text-sm">
                {phase === 'start' ? '起始' : '结束'}计划 · {subject.label}
              </legend>
              {STATE_FIELDS.filter((field) => field !== 'holder' || subject.kind === 'prop').map(
                (field) => {
                  const value = resolved[phase][subject.id]?.[field]
                  const inherited = phase === 'start' && linked(field)
                  return (
                    <div key={field} className="text-sm">
                      <label>
                        {stateLabels[field]}
                        {field === 'holder' ? (
                          <div className="flex gap-2">
                            <select
                              aria-label={`${phase === 'start' ? '起始' : '结束'}${stateLabels[field]}`}
                              className="ui-input min-w-0 flex-1"
                              disabled={inherited}
                              value={typeof value === 'object' ? value.subjectId : ''}
                              onChange={(e) =>
                                change(
                                  phase,
                                  field,
                                  e.target.value
                                    ? {
                                        subjectId: e.target.value,
                                        hand: typeof value === 'object' ? value.hand : 'right',
                                      }
                                    : undefined,
                                )
                              }
                            >
                              <option value="">未计划</option>
                              {record.subjects
                                .filter((s) => s.kind === 'character')
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.label} · {s.id.slice(-6)}
                                  </option>
                                ))}
                            </select>
                            <select
                              aria-label={`${phase === 'start' ? '起始' : '结束'}持物手`}
                              className="ui-input"
                              disabled={inherited || typeof value !== 'object'}
                              value={typeof value === 'object' ? value.hand : 'right'}
                              onChange={(e) => {
                                if (typeof value === 'object')
                                  change(phase, field, {
                                    ...value,
                                    hand: e.target.value as 'left' | 'right' | 'both',
                                  })
                              }}
                            >
                              <option value="right">右手</option>
                              <option value="left">左手</option>
                              <option value="both">双手</option>
                            </select>
                          </div>
                        ) : (
                          <input
                            aria-label={`${phase === 'start' ? '起始' : '结束'}${stateLabels[field]}`}
                            className="ui-input w-full"
                            disabled={inherited}
                            value={typeof value === 'string' ? value : ''}
                            onChange={(e) => change(phase, field, e.target.value)}
                            placeholder="未计划"
                          />
                        )}
                      </label>
                      {inherited && (
                        <button
                          type="button"
                          className={`${button} mt-1`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              inherits: draft.inherits
                                .map((r) =>
                                  r.subjectId === subject.id
                                    ? { ...r, fields: r.fields.filter((f) => f !== field) }
                                    : r,
                                )
                                .filter((r) => r.fields.length),
                            })
                          }
                        >
                          解除此字段引用
                        </button>
                      )}
                    </div>
                  )
                },
              )}
            </fieldset>
          ))}
        </div>
      )}
      <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
        <label>
          连续关系
          <select
            aria-label="连续关系"
            className="ui-input ml-2"
            disabled={!writable}
            value={draft.reset?.kind ?? ''}
            onChange={(e) =>
              setDraft(
                e.target.value
                  ? {
                      ...draft,
                      inherits: [],
                      reset: {
                        kind: e.target.value as 'time_jump' | 'new_scene' | 'flashback',
                        reason: '',
                      },
                    }
                  : { ...draft, reset: undefined },
              )
            }
          >
            <option value="">允许明确引用前镜计划</option>
            <option value="time_jump">时间跳跃，重置继承</option>
            <option value="new_scene">独立场景，重置继承</option>
            <option value="flashback">插叙，重置继承</option>
          </select>
        </label>
        {draft.reset ? (
          <input
            aria-label="重置原因"
            className="ui-input w-full"
            disabled={!writable}
            value={draft.reset.reason}
            onChange={(e) =>
              setDraft({ ...draft, reset: { ...draft.reset!, reason: e.target.value } })
            }
            placeholder="说明这里为何不沿用前镜状态"
          />
        ) : (
          subject && (
            <>
              <select
                aria-label="引用计划版本"
                className="ui-input w-full"
                disabled={!writable}
                value={inheritPlanId}
                onChange={(e) => {
                  setInheritPlanId(e.target.value)
                  setInheritFields([])
                }}
              >
                <option value="">选择确切镜头与计划版本</option>
                {record.plans
                  .filter((p) => p.shotId !== shotId && shots.some((s) => s.id === p.shotId))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      镜头 {shots.find((s) => s.id === p.shotId)?.no} · {p.id.slice(-8)}
                    </option>
                  ))}
              </select>
              <div className="flex flex-wrap gap-3">
                {STATE_FIELDS.filter(
                  (field) =>
                    record.plans.find((p) => p.id === inheritPlanId)?.content.end[subject.id]?.[
                      field
                    ] !== undefined,
                ).map((field) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      disabled={!writable}
                      checked={inheritFields.includes(field)}
                      onChange={(e) =>
                        setInheritFields(
                          e.target.checked
                            ? [...inheritFields, field]
                            : inheritFields.filter((f) => f !== field),
                        )
                      }
                    />
                    {stateLabels[field]}
                  </label>
                ))}
              </div>
              <button
                type="button"
                className={button}
                disabled={!writable || !inheritFields.length}
                onClick={() => {
                  const source = record.plans.find((p) => p.id === inheritPlanId)
                  if (!source) return
                  const next = copy(draft)
                  for (const field of inheritFields) delete next.start[subject.id]?.[field]
                  next.inherits = next.inherits
                    .map((r) =>
                      r.subjectId === subject.id
                        ? { ...r, fields: r.fields.filter((f) => !inheritFields.includes(f)) }
                        : r,
                    )
                    .filter((r) => r.fields.length)
                  next.inherits.push({
                    fromShotId: source.shotId,
                    planRevisionId: source.id,
                    subjectId: subject.id,
                    fields: [...inheritFields],
                  })
                  setDraft(next)
                }}
              >
                引用所选版本的结束字段
              </button>
            </>
          )
        )}
      </div>
      <ul aria-label="计划状态依赖" className="text-sm">
        {continuityDependencies(record, shotId, new Set(shots.map((s) => s.id))).map((ref) => (
          <li
            key={JSON.stringify([
              ref.toPlanRevisionId,
              ref.planRevisionId,
              ref.subjectId,
              ref.fields,
            ])}
          >
            引用镜头 {shots.find((s) => s.id === ref.fromShotId)?.no ?? '已删除'} 的{' '}
            {ref.planRevisionId.slice(-8)}：{ref.fields.map((f) => stateLabels[f]).join('、')} ·{' '}
            {ref.status === 'current'
              ? '所引字段一致'
              : ref.status === 'changed'
                ? '所引字段已变，请人工复核'
                : ref.status === 'conflict'
                  ? '所引字段存在分支冲突'
                  : '引用来源缺失'}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="ui-btn ui-btn-primary"
        disabled={
          !writable ||
          !shot ||
          changed ||
          (current.state === 'conflict' && !current.heads.some((p) => p.id === branch))
        }
        onClick={() => {
          const userId = guard()
          if (!userId) {
            setError('当前不可写或已切换目标')
            return
          }
          const saved = appendShotPlan(engine.doc, {
            scope: { canvasId, boardId },
            shotId,
            expectedHeads: heads,
            content: draft,
            userId,
          })
          if (saved) {
            setHeads([saved.id])
            setError('')
          } else setError('计划、引用或主体已变化，请重新载入后核对')
        }}
      >
        保存计划新版本
      </button>
      <details className="text-sm text-ink-subtle">
        <summary>计划历史（{record.plans.filter((p) => p.shotId === shotId).length}）</summary>
        {record.plans
          .filter((p) => p.shotId === shotId)
          .map((p) => (
            <p key={p.id}>
              {p.id.slice(-8)} · {p.content.intent || '未填写目的'} · {p.userId}
            </p>
          ))}
      </details>
    </section>
  )
}

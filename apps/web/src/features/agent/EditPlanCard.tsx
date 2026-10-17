import {
  type AgentItem,
  type ApplyEditPlan,
  type EditEstimate,
  type EditFieldChange,
  type EditScope,
  type EditStage,
  type EditTarget,
  estimateSteps,
  pickedTargets,
  stepsFor,
} from '@plein/protocol'
import { useState } from 'react'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { useAgent } from './store'

const STAGE_LABELS: Record<EditStage, string> = {
  image: '镜头图',
  video: '视频',
  speech: '配音',
  sfx: '音效',
  other: '其他',
}

const SCOPE_LABELS: Record<EditScope, string> = {
  text: '只改文字',
  images: '只出候选图',
  full: '完整方案',
}

/** 某个批准范围的调用与费用；缺价格时标明未知 */
function costText(e: EditEstimate) {
  const reuse = e.cached ? `，沿用 ${e.cached} 个已有候选` : ''
  if (!e.calls) return `不调用平台${reuse}`
  const price = e.cost.currency
    ? `约 ${Number(e.cost.amount.toFixed(2))} ${e.cost.currency}${e.cost.unknown ? `，${e.cost.unknown} 次价格未知` : ''}`
    : '价格未知'
  return `调用平台 ${e.calls} 次 · ${price}${reuse}`
}

const show = (v: unknown) =>
  v === undefined || v === '' ? '（空）' : typeof v === 'string' ? v : JSON.stringify(v)

const shotOf = (s: { shot?: { no?: number } }) => (s.shot?.no ? `第 ${s.shot.no} 镜 · ` : '')

/** 按阶段数：镜头图 ×1 · 视频 ×1 */
function stageCounts(steps: Array<{ stage: EditStage }>) {
  const n = new Map<EditStage, number>()
  for (const s of steps) n.set(s.stage, (n.get(s.stage) ?? 0) + 1)
  return [...n].map(([stage, count]) => `${STAGE_LABELS[stage]} ×${count}`).join(' · ')
}

/** 文字字段才能在卡片上直接改 */
const editable = (c: EditFieldChange) =>
  (c.before === undefined || typeof c.before === 'string') && typeof c.after === 'string'

/**
 * 每个目标完整的改动，按卡片上的修改替换或去掉某一项；
 * 去掉后没有改动的目标整个不要
 */
function editsOf(
  targets: EditTarget[],
  patch: { nodeId: string; key: string; value?: string; drop?: boolean },
) {
  return targets
    .map((t) => ({
      id: t.nodeId,
      params: Object.fromEntries(
        t.changes
          .filter((c) => !(patch.drop && t.nodeId === patch.nodeId && c.key === patch.key))
          .map((c) => [
            c.key,
            t.nodeId === patch.nodeId && c.key === patch.key && !patch.drop ? patch.value : c.after,
          ]),
      ),
    }))
    .filter((e) => Object.keys(e.params).length > 0)
}

/**
 * 修改方案卡片：要改的字段（前后值）、改完后实际送的参考、会运行的节点和保留项。
 * 等批准时可以逐项编辑：改某个字段的新值、去掉某项改动（服务端重新检查方案）、
 * 不勾某个目标或某个步骤（只影响这次批准的范围和估算），再按范围批准：只改文字 / 只出候选图 / 完整方案
 */
export function EditPlanRow({ item }: { item: Extract<AgentItem, { type: 'edit_plan' }> }) {
  const engine = useCanvas((s) => s.engine)
  const [busy, setBusy] = useState(false)
  const [revising, setRevising] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 不勾的目标 / 步骤（节点 id） */
  const [off, setOff] = useState<ReadonlySet<string>>(new Set())
  const [skip, setSkip] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<{ nodeId: string; key: string; draft: string } | null>(
    null,
  )
  const { plan } = item
  const pending = item.status === 'pending' && plan.status === 'pending'
  const locked = busy || revising
  const ids = plan.targets.map((t) => t.nodeId).filter((id) => engine?.doc.get(id))

  const only = plan.targets.some((t) => off.has(t.nodeId))
    ? plan.targets.filter((t) => !off.has(t.nodeId)).map((t) => t.nodeId)
    : undefined
  const skipped = plan.steps.filter((s) => skip.has(s.nodeId)).map((s) => s.nodeId)
  const chosen = new Set(pickedTargets(plan, only).map((t) => t.nodeId))
  const est = (scope: EditScope) => estimateSteps(stepsFor(plan, scope, only, skipped))
  const imageSteps = stepsFor(plan, 'images', only, skipped)
  const changeCount = plan.targets.reduce((n, t) => n + t.changes.length, 0)

  const decide = async (allow: boolean, scope?: EditScope) => {
    setBusy(true)
    const pick: ApplyEditPlan | undefined = scope
      ? { scope, ...(only ? { only } : {}), ...(skipped.length ? { skip: skipped } : {}) }
      : undefined
    await useAgent.getState().decide(item.id, allow, pick)
    setBusy(false)
  }
  const revise = async (patch: Parameters<typeof editsOf>[1]) => {
    setRevising(true)
    setError(null)
    const failed = await useAgent.getState().revisePlan(item.id, editsOf(plan.targets, patch))
    setRevising(false)
    if (failed) setError(failed)
    else setEditing(null)
  }
  const toggle = (set: typeof setOff, id: string) =>
    set((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const images = plan.steps.filter((s) => s.scope === 'images')
  const fullOnly = plan.steps.filter((s) => s.scope === 'full')
  const name = (id: string) =>
    plan.targets.find((t) => t.nodeId === id)?.name ??
    plan.steps.find((s) => s.nodeId === id)?.name ??
    id
  const status =
    plan.status === 'applied' && plan.applied
      ? `已执行${SCOPE_LABELS[plan.applied.scope]}${plan.applied.nodes.length ? `，运行 ${plan.applied.nodes.length} 个节点` : '，没有调用平台'}`
      : plan.status === 'stale'
        ? '目标在批准前变了，旧方案没有执行'
        : item.status === 'denied' || plan.status === 'denied'
          ? '方案没有采用'
          : item.status === 'expired' || plan.status === 'expired'
            ? '方案已过期'
            : item.status === 'approved'
              ? `正在执行${item.scope ? SCOPE_LABELS[item.scope] : ''}`
              : plan.revised
                ? '改过的修改方案'
                : '小满的修改方案'
  /** 执行后没写进画布的目标 */
  const left = (t: EditTarget) =>
    plan.status === 'applied' && plan.applied && !plan.applied.targets.includes(t.nodeId)

  return (
    <div
      className={`plein-agent-approval plein-edit-plan flex flex-col gap-2 rounded-lg px-3 py-2.5 text-xs ring-1 ring-inset ${pending ? 'bg-accent-soft/50 text-ink ring-accent/40' : 'text-ink ring-line'}`}
      data-status={plan.status}
      data-revising={revising || undefined}
      aria-busy={revising || undefined}
      onPointerEnter={() => {
        if (ids.length) engine?.flash(ids)
      }}
    >
      <div className="flex items-center gap-2 text-ink-muted">
        {revising ? (
          <span className="ui-spinner size-3.5 flex-none" />
        ) : (
          <Icon
            name={
              plan.status === 'stale' ? 'warning' : plan.status === 'applied' ? 'check' : 'wand'
            }
            size={14}
          />
        )}
        <span className="min-w-0 flex-1 truncate">
          {revising ? '重新检查方案…' : `${status}：${plan.summary}`}
        </span>
        {ids.length > 0 && engine && (
          <button
            type="button"
            aria-label="在画布上查看"
            title="在画布上查看"
            className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
            onClick={() => engine.flyTo(ids)}
          >
            <Icon name="locate" size={14} />
          </button>
        )}
      </div>
      <ul className="plein-edit-plan-body flex flex-col gap-2">
        {plan.targets.map((t) => {
          const included = pending ? !off.has(t.nodeId) : !left(t)
          return (
            <li
              key={t.nodeId}
              className="plein-edit-target flex flex-col gap-1"
              data-off={!included || undefined}
            >
              <span className="flex items-center gap-2 font-medium">
                {pending && plan.targets.length > 1 && (
                  <input
                    type="checkbox"
                    aria-label={`改${shotOf(t)}${t.name}`}
                    checked={included}
                    disabled={locked || (included && chosen.size === 1)}
                    onChange={() => toggle(setOff, t.nodeId)}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {shotOf(t)}
                  {t.name}
                </span>
                {!pending && !included && <span className="text-ink-subtle">没有改</span>}
              </span>
              {t.changes.map((c) => {
                const open = editing?.nodeId === t.nodeId && editing.key === c.key
                return (
                  <div key={c.key} className="plein-edit-change flex flex-col gap-0.5 leading-4">
                    <span className="flex min-h-5 items-center gap-1 text-ink-subtle">
                      <span className="min-w-0 flex-1 truncate">{c.label}</span>
                      {pending && included && !open && (
                        <span className="plein-edit-tools flex gap-0.5">
                          {editable(c) && (
                            <button
                              type="button"
                              aria-label={`改${c.label}`}
                              title="改成别的写法"
                              className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
                              disabled={locked}
                              onClick={() => {
                                setError(null)
                                setEditing({
                                  nodeId: t.nodeId,
                                  key: c.key,
                                  draft: String(c.after ?? ''),
                                })
                              }}
                            >
                              <Icon name="pencil" size={12} />
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`不改${c.label}`}
                            title={changeCount > 1 ? '不改这一项' : '方案里只剩这一项'}
                            className="ui-btn ui-btn-xs ui-btn-quiet ui-icon-btn"
                            disabled={locked || changeCount <= 1}
                            onClick={() =>
                              void revise({ nodeId: t.nodeId, key: c.key, drop: true })
                            }
                          >
                            <Icon name="x" size={12} />
                          </button>
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 break-words text-ink-subtle line-through">
                      {show(c.before)}
                    </span>
                    {open ? (
                      <form
                        className="flex flex-col gap-1.5"
                        onSubmit={(e) => {
                          e.preventDefault()
                          void revise({ nodeId: t.nodeId, key: c.key, value: editing.draft })
                        }}
                      >
                        <textarea
                          aria-label={`${c.label}改成`}
                          className="ui-input h-24 py-1.5 text-xs leading-4"
                          value={editing.draft}
                          maxLength={20_000}
                          // oxlint-disable-next-line jsx-a11y/no-autofocus -- 点了编辑才出现，直接接着写
                          autoFocus
                          disabled={revising}
                          onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation()
                              setEditing(null)
                            }
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                              e.preventDefault()
                              e.currentTarget.form?.requestSubmit()
                            }
                          }}
                        />
                        <span className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            className="ui-btn ui-btn-xs ui-btn-quiet"
                            disabled={revising}
                            onClick={() => setEditing(null)}
                          >
                            取消
                          </button>
                          <button
                            type="submit"
                            className="ui-btn ui-btn-xs ui-btn-secondary"
                            disabled={revising || editing.draft === c.after}
                            title="按新写法重新检查参考、要重做的节点和费用（⌘↵）"
                          >
                            重新检查
                          </button>
                        </span>
                      </form>
                    ) : (
                      <span className="line-clamp-3 break-words">{show(c.after)}</span>
                    )}
                  </div>
                )
              })}
              {t.refs.length > 0 && (
                <span className="text-ink-subtle">
                  参考：
                  {t.refs
                    .map(
                      (r) => `${r.name}${r.sent.length ? ` ${r.sent.length} 张` : '（只附文字）'}`,
                    )
                    .join('、')}
                </span>
              )}
              {t.issues.map((i) => (
                <span key={i.code + (i.elementId ?? '')} className="text-warning">
                  {i.message}
                </span>
              ))}
            </li>
          )
        })}
      </ul>
      {error && <p className="text-danger">{error}</p>}
      {pending && plan.steps.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-ink-subtle">批准后会运行</span>
          <ul className="flex flex-col gap-0.5">
            {plan.steps.map((s) => {
              const reached = s.targets.some((t) => chosen.has(t))
              return (
                <li key={s.nodeId} className="plein-edit-step" data-off={!reached || undefined}>
                  <label className="flex min-h-6 items-center gap-2">
                    <input
                      type="checkbox"
                      aria-label={`运行${shotOf(s)}${s.name}`}
                      checked={reached && !skip.has(s.nodeId)}
                      disabled={locked || !reached}
                      onChange={() => toggle(setSkip, s.nodeId)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {shotOf(s)}
                      {s.name}
                    </span>
                    <span className="flex-none text-ink-subtle">
                      {STAGE_LABELS[s.stage]}
                      {s.cached ? ' · 沿用已有候选' : s.scope === 'full' ? ' · 完整方案' : ''}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-muted">
        {!pending && images.length > 0 && (
          <>
            <dt className="text-ink-subtle">出候选图</dt>
            <dd>{images.map((s) => `${shotOf(s)}${s.name}`).join('、')}</dd>
          </>
        )}
        {!pending && fullOnly.length > 0 && (
          <>
            <dt className="text-ink-subtle">完整方案还会</dt>
            <dd>{stageCounts(fullOnly)}</dd>
          </>
        )}
        {(plan.keep.length > 0 || plan.untouched > 0) && (
          <>
            <dt className="text-ink-subtle">保留</dt>
            <dd>
              {[
                ...plan.keep.map((k) => `${shotOf(k)}${k.name}`),
                ...(plan.untouched ? [`其余 ${plan.untouched} 个结果不受影响`] : []),
              ].join('、')}
            </dd>
          </>
        )}
        {plan.status === 'stale' && plan.changed && (
          <>
            <dt className="text-ink-subtle">变了的</dt>
            <dd>{plan.changed.map(name).join('、')}，让小满重新检查</dd>
          </>
        )}
      </dl>
      {pending && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface-2 px-2 py-1.5 text-ink-muted">
            {(['text', 'images', 'full'] as const).map((scope) => (
              <div key={scope} className="contents">
                <dt className="text-ink-subtle">{SCOPE_LABELS[scope]}</dt>
                <dd className="plein-edit-cost tabular-nums">{costText(est(scope))}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap justify-end gap-1.5">
            <button
              type="button"
              className="ui-btn ui-btn-xs ui-btn-quiet"
              disabled={locked}
              onClick={() => void decide(false)}
            >
              不用了
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-xs ui-btn-secondary"
              disabled={locked || editing !== null}
              title="只把文字改动写进画布，不调用平台"
              onClick={() => void decide(true, 'text')}
            >
              只改文字
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-xs ui-btn-secondary"
              disabled={locked || editing !== null || imageSteps.length === 0}
              title={costText(est('images'))}
              onClick={() => void decide(true, 'images')}
            >
              只出候选图
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-xs ui-btn-primary"
              disabled={locked || editing !== null}
              title={costText(est('full'))}
              onClick={() => void decide(true, 'full')}
            >
              执行完整方案
            </button>
          </div>
        </>
      )}
    </div>
  )
}

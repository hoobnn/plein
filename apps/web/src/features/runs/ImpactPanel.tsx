import type { Engine } from '@plein/canvas-core'
import type { ImpactNode, ImpactReport, ImpactSuggestion, SequenceIssue } from '@plein/protocol'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ApiError, api } from '../../api/client'
import { useDocVersion } from '../../canvas/hooks'
import { storyboardLabels } from '../storyboard/sourceLabels'
import { describeImpactRun, runImpact } from '../../canvas/groups'
import { useCanvas } from '../../stores/canvas'
import { EmptyState } from '../../ui/EmptyState'
import { relativeTime } from '../../ui/format'
import { Icon } from '../../ui/icons'
import { Modal, ModalHeader } from '../../ui/Modal'
import { Presence } from '../../ui/Presence'
import { StoryboardSync } from '../storyboard/StoryboardSync'
import { refreshStale } from './stale'
import { groupRunSignal } from './groupRuns'

/** 保留决定不写文档；当前打开的同画布面板仍需获知后台完成的变更。 */
const impactChanges = new Set<(engine: Engine, canvasId: string) => void>()
const impactChanged = (engine: Engine, canvasId: string) => {
  refreshStale(engine, canvasId)
  for (const notify of impactChanges) notify(engine, canvasId)
}

const ROLE_LABEL = { image: '镜头图', video: '视频', speech: '配音', sfx: '音效' } as const

const SUGGEST: Record<ImpactSuggestion, string> = {
  rerun: '建议重做',
  review: '建议审查',
  keep: '建议保留',
  sync: '先看分镜差异',
}

const IMPACT: Record<ImpactNode['impact'], { label: string; tag: string }> = {
  direct: { label: '直接', tag: 'ui-tag-warning' },
  indirect: { label: '间接', tag: '' },
  related: { label: '可选', tag: '' },
}

/** 分镜计划没同步的节点要先看差异，不能直接重做 */
const selectable = (n: ImpactNode) => n.suggest !== 'sync'

/** 默认勾选：建议重做、没保留过的 */
const defaults = (r: ImpactReport) =>
  new Set(r.nodes.filter((n) => n.suggest === 'rerun' && !n.kept).map((n) => n.nodeId))

/** 按镜头分组：同一镜头的节点放在一起，不属于镜头的归到最后 */
function groupByShot(nodes: ImpactNode[]) {
  const out: Array<{ key: string; title: string; nodes: ImpactNode[]; storyboard?: string }> = []
  for (const n of nodes) {
    const key = n.shot ? `${n.shot.storyboard}/${n.shot.id}` : 'other'
    const title = n.shot
      ? n.shot.no
        ? `镜头 ${String(n.shot.no).padStart(2, '0')}`
        : '已删除的镜头'
      : '其他节点'
    const g = out.find((x) => x.key === key)
    if (g) g.nodes.push(n)
    else out.push({ key, title, nodes: [n], storyboard: n.shot?.storyboard })
  }
  return out
}

/** 「查看影响」：修改之后哪些结果过期、为什么、建议怎么处理；保留、只改配音字幕或勾选重做 */
export function ImpactPanel() {
  const open = useCanvas((s) => s.impact)
  const engine = useCanvas((s) => s.engine)
  const canvasId = useCanvas((s) => s.canvasId)
  return (
    <Presence>
      {open && engine && canvasId && (
        <Panel
          key={canvasId}
          engine={engine}
          canvasId={canvasId}
          onClose={() => useCanvas.getState().toggleImpact(false)}
        />
      )}
    </Presence>
  )
}

function Panel({
  engine,
  canvasId,
  onClose,
}: {
  engine: Engine
  canvasId: string
  onClose(): void
}) {
  useDocVersion(engine.doc)
  const sources = storyboardLabels(engine.doc)
  const notify = useCanvas((s) => s.notify)
  const open = useCanvas((s) => s.impact)
  const mounted = useRef(true)
  const actionPending = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const isCurrent = useCallback(() => {
    const state = useCanvas.getState()
    return mounted.current && state.impact && state.engine === engine && state.canvasId === canvasId
  }, [engine, canvasId])
  const [report, setReport] = useState<ImpactReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const requestId = useRef(0)
  const [syncing, setSyncing] = useState<{ board: string; shots: string[] } | null>(null)
  /** 上次分析里每个节点的建议与保留状态：变了才重新按建议勾选 */
  const seen = useRef(new Map<string, string>())

  const load = useCallback(async () => {
    if (!isCurrent()) return
    const id = ++requestId.current
    setRefreshing(true)
    try {
      const r = await api.canvasImpact(canvasId)
      if (id !== requestId.current || !isCurrent()) return
      setReport(r)
      setError(null)
      // 新出现的节点、建议变了的节点按建议勾选；其余保留用户的勾选，去掉已经不在列表里的
      const before = seen.current
      const after = new Map(r.nodes.map((n) => [n.nodeId, `${n.suggest}/${n.kept?.id ?? ''}`]))
      seen.current = after
      setPicked((prev) => {
        const next = new Set<string>()
        const auto = defaults(r)
        for (const n of r.nodes) {
          if (!selectable(n)) continue
          const same = before.get(n.nodeId) === after.get(n.nodeId)
          if (same ? prev?.has(n.nodeId) : auto.has(n.nodeId)) next.add(n.nodeId)
        }
        return next
      })
    } catch (err) {
      if (id === requestId.current && isCurrent()) setError((err as Error).message)
    } finally {
      if (id === requestId.current && isCurrent()) setRefreshing(false)
    }
  }, [canvasId, isCurrent])

  const invalidate = useCallback(() => {
    requestId.current++
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
    // 文档变了（同步了计划、跑完了节点）停一会儿再重新分析
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = engine.doc.subscribe(() => {
      // 文档一变就让旧请求失效，防抖等待期间也不能按旧报告执行。
      invalidate()
      setRefreshing(true)
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 800)
    })
    const changed = (source: Engine, canvas: string) => {
      if (source !== engine || canvas !== canvasId || actionPending.current) return
      clearTimeout(timer)
      void load()
    }
    impactChanges.add(changed)
    return () => {
      invalidate()
      off()
      impactChanges.delete(changed)
      clearTimeout(timer)
    }
  }, [open, engine, canvasId, load, invalidate])

  const unavailable = !open || busy || refreshing || !!error
  const nodes = useMemo(() => report?.nodes ?? [], [report])
  const groups = useMemo(() => groupByShot(nodes), [nodes])
  const chosen = nodes.filter((n) => picked?.has(n.nodeId))
  const reuse = chosen.filter((n) => n.cached).length
  const calls = chosen.filter((n) => !n.cached)
  const priced = calls.filter((n) => n.price)
  const unknown = calls.length - priced.length
  const currency = priced[0]?.price?.currency
  const amount = priced.reduce((t, n) => t + (n.price?.amount ?? 0), 0)

  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked)
    if (on) next.add(id)
    else next.delete(id)
    setPicked(next)
  }
  const speechOnly = () =>
    setPicked(
      new Set(
        nodes
          .filter((n) => selectable(n) && n.shot?.role === 'speech' && n.impact !== 'related')
          .map((n) => n.nodeId),
      ),
    )

  const beginAction = () => {
    if (unavailable || actionPending.current || !isCurrent()) return false
    actionPending.current = true
    setBusy(true)
    return true
  }
  const finishAction = () => {
    actionPending.current = false
    if (mounted.current) setBusy(false)
    if (isCurrent()) void load()
  }

  const keep = async (list: ImpactNode[]) => {
    const targets = list.filter((n) => n.inputHash && !n.kept && n.impact !== 'related')
    if (!targets.length || !beginAction()) return
    try {
      await api.keepResults(canvasId, {
        nodes: targets.map((n) => ({ nodeId: n.nodeId, inputHash: n.inputHash! })),
      })
      impactChanged(engine, canvasId)
      if (!isCurrent()) return
      notify(`已保留 ${targets.length} 个结果，记录在「保留记录」里`)
    } catch (err) {
      if (!isCurrent()) return
      notify(
        err instanceof ApiError && err.code === 'input_changed'
          ? '有节点的输入刚刚又变了，已重新分析，请再确认一次'
          : (err as Error).message,
      )
    } finally {
      finishAction()
    }
  }
  const revoke = async (id: string) => {
    if (!beginAction()) return
    try {
      await api.revokeKeep(canvasId, id)
      impactChanged(engine, canvasId)
    } catch (err) {
      if (isCurrent()) notify((err as Error).message)
    } finally {
      finishAction()
    }
  }

  const rerun = async () => {
    const ids = chosen.map((n) => n.nodeId)
    if (unavailable || !ids.length) return
    const signal = groupRunSignal()
    onClose()
    try {
      const r = await runImpact(canvasId, ids, {
        signal,
        onStart: () => notify(`已开始重做 ${ids.length} 个结果，其余镜头不动`),
      })
      notify(describeImpactRun(r))
    } catch (err) {
      if (!signal.aborted) notify((err as Error).message)
    }
  }

  const locate = (id: string) => {
    if (!isCurrent()) return
    if (!engine.doc.has(id)) {
      notify('节点已被删除，已重新分析当前影响')
      void load()
      return
    }
    onClose()
    engine.selection.set([id])
    engine.zoomToFit([id])
  }

  const summary = report?.summary
  const keepable = nodes.filter(
    (n) => n.impact !== 'related' && !n.kept && n.inputHash && !picked?.has(n.nodeId),
  )

  return (
    <Modal label="查看影响" onClose={onClose} className="max-w-180">
      <ModalHeader
        title="修改的影响"
        onClose={onClose}
        meta={
          summary &&
          nodes.length > 0 && (
            <span className="ui-chip tabular-nums">
              直接 {summary.direct} · 间接 {summary.indirect}
              {summary.kept ? ` · 已保留 ${summary.kept}` : ''}
            </span>
          )
        }
      />
      <div className="ui-scrollbar min-h-0 flex-1 overflow-auto px-5 py-4">
        {error ? (
          <div role="alert" className="mb-3 flex items-center gap-2 text-xs text-danger">
            <span>分析失败：{error}。重新分析后再保留或重做。</span>
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-secondary ml-auto flex-none"
              disabled={refreshing}
              onClick={() => void load()}
            >
              重新分析
            </button>
          </div>
        ) : refreshing && report ? (
          <p role="status" className="mb-3 text-xs text-ink-subtle">
            正在重新分析，完成后可保留或重做。
          </p>
        ) : null}
        {!report ? (
          <p className="py-6 text-center text-xs text-ink-subtle">{!error && '正在分析…'}</p>
        ) : nodes.length === 0 && report.sequence.length === 0 ? (
          <EmptyState
            icon="check"
            title="没有受影响的结果"
            hint="改了参数、台词、参考图或换了候选之后，受影响的结果会列在这里。过期只表示需要审查，不会自动重新生成。"
          />
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-xs text-ink-subtle">
              过期只表示需要审查，不会自动重新生成。勾选要重做的节点；不勾的保留现有结果，可以点「保留」记下这个决定。
            </p>
            {report.plan.length > 0 && (
              <section className="rounded-lg border border-line p-3">
                <h3 className="ui-section-title mb-2">分镜表有没同步的改动</h3>
                <ul className="flex flex-col gap-1.5">
                  {report.plan.map((p) => (
                    <PlanRow
                      key={`${p.storyboard}/${p.shot}`}
                      source={sources.get(p.storyboard) ?? '已删除的分镜'}
                      no={p.no}
                      fields={p.fields}
                      disabled={!sources.has(p.storyboard)}
                      onOpen={() => setSyncing({ board: p.storyboard, shots: [p.shot] })}
                    />
                  ))}
                </ul>
              </section>
            )}
            {report.sequence.length > 0 && (
              <section className="rounded-lg border border-line p-3">
                <h3 className="ui-section-title mb-2">序列需要检查</h3>
                <p className="mb-2 text-xs text-ink-subtle">
                  序列已经跟着换了来源，原入出点保留没动；下面这些地方请在序列里看一下。
                </p>
                <ul className="flex flex-col gap-1.5">
                  {report.sequence.map((s) => (
                    <li
                      key={`${s.sequenceId}/${s.source}/${s.kind}`}
                      className="flex items-baseline gap-2 text-sm"
                    >
                      <span className="translate-y-0.5 text-warning">
                        <Icon name="warning" size={14} />
                      </span>
                      <span className="text-ink-muted">{shotTitle(nodes, s, engine)}</span>
                      <span className="text-ink">{s.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {groups.map((g) => (
              <section key={g.key} className="rounded-lg border border-line">
                <h3 className="ui-section-title min-w-0 border-b border-line px-3 py-2">
                  {g.storyboard && (
                    <span
                      className="mb-0.5 block truncate text-xs font-normal text-ink-muted"
                      title={sources.get(g.storyboard) ?? '已删除的分镜'}
                    >
                      {sources.get(g.storyboard) ?? '已删除的分镜'}
                    </span>
                  )}
                  {g.title}
                </h3>
                <ul className="divide-y divide-line">
                  {g.nodes.map((n) => (
                    <Row
                      key={n.nodeId}
                      node={n}
                      checked={!!picked?.has(n.nodeId)}
                      busy={unavailable}
                      onToggle={(on) => toggle(n.nodeId, on)}
                      onKeep={() => void keep([n])}
                      onRevoke={() => n.kept && void revoke(n.kept.id)}
                      onLocate={() => locate(n.nodeId)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {report.decisions.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-xs text-ink-subtle">
                  保留记录（{report.decisions.length}）
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {report.decisions.map((d) => {
                    const live = nodes.some((n) => n.kept?.id === d.id)
                    return (
                      <li key={d.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                        <span className="text-ink">
                          {engine.doc.get(d.nodeId)?.name ?? '已删除的节点'}
                        </span>
                        <span className="text-ink-subtle">{relativeTime(d.createdAt)}</span>
                        <span className="text-ink-muted">
                          {d.causes.map((c) => c.label).join('；') || '结果仍有效'}
                        </span>
                        <span className={`ui-tag ${live ? 'ui-tag-success' : ''}`}>
                          {d.revokedAt ? '已撤销' : live ? '生效中' : '已不适用'}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>
      {nodes.length > 0 && (
        <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          <span role="status" className="text-xs text-ink-subtle tabular-nums">
            {busy ? (
              '正在更新保留决定…'
            ) : (
              <>
                已选 {chosen.length} 个{reuse > 0 && ` · ${reuse} 个沿用已有候选`}
                {calls.length > 0 && ` · ${calls.length} 个调用平台`}
                {calls.length > 0 &&
                  (priced.length
                    ? ` · 预估 ${amount.toFixed(2)} ${currency}${unknown ? `，${unknown} 个价格未知` : ''}`
                    : ' · 价格未知')}
              </>
            )}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={unavailable}
              onClick={speechOnly}
            >
              <Icon name="mic" />
              只改配音 / 字幕
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={unavailable || !keepable.length}
              title="没勾选的过期结果记为保留：不改缓存，之后输入再变会重新提示"
              onClick={() => void keep(keepable)}
            >
              保留其余{keepable.length ? `（${keepable.length}）` : ''}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={unavailable || !chosen.length}
              onClick={() => void rerun()}
            >
              <Icon name="retry" />
              重做选中的 {chosen.length} 个
            </button>
          </div>
        </footer>
      )}
      {syncing && (
        <StoryboardSync
          engine={engine}
          boardId={syncing.board}
          shotIds={syncing.shots}
          isCurrent={isCurrent}
          onClose={() => {
            setSyncing(null)
            void load()
          }}
        />
      )}
    </Modal>
  )
}

/** 序列问题对应的镜头：报告里有这个镜头时用镜号，否则用来源节点的名字 */
function shotTitle(nodes: ImpactNode[], issue: SequenceIssue, engine: Engine) {
  const no = issue.shotId && nodes.find((n) => n.shot?.id === issue.shotId)?.shot?.no
  if (no) return `镜头 ${String(no).padStart(2, '0')}`
  return engine.doc.get(issue.source)?.name ?? '镜头'
}

function Row({
  node: n,
  checked,
  busy,
  onToggle,
  onKeep,
  onRevoke,
  onLocate,
}: {
  node: ImpactNode
  checked: boolean
  busy: boolean
  onToggle(on: boolean): void
  onKeep(): void
  onRevoke(): void
  onLocate(): void
}) {
  const role = n.shot ? ROLE_LABEL[n.shot.role] : undefined
  const impact = IMPACT[n.impact]
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <input
        type="checkbox"
        className="mt-0.5"
        aria-label={`重做${role ?? n.name}`}
        disabled={busy || !selectable(n)}
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="truncate text-sm font-medium text-ink hover:underline"
            title="在画布上定位"
            onClick={onLocate}
          >
            {role ?? n.name}
          </button>
          {role && <span className="truncate text-xs text-ink-subtle">{n.name}</span>}
          <span className={`ui-tag ${impact.tag}`}>{impact.label}</span>
          <span className="text-xs text-ink-muted">{SUGGEST[n.suggest]}</span>
          {n.cached && <span className="ui-tag ui-tag-success">可沿用已有候选</span>}
          {n.kept && (
            <span className="ui-tag ui-tag-accent" title={n.kept.note}>
              已保留 · {relativeTime(n.kept.createdAt)}
            </span>
          )}
        </div>
        {n.causes.length > 0 && (
          <p className="mt-0.5 text-xs text-ink-muted">{n.causes.map((c) => c.label).join('；')}</p>
        )}
      </div>
      {n.price && (
        <span className="flex-none text-xs text-ink-subtle tabular-nums">
          {n.price.amount} {n.price.currency}
        </span>
      )}
      {n.kept ? (
        <button
          type="button"
          className="ui-btn ui-btn-xs ui-btn-quiet flex-none"
          disabled={busy}
          onClick={onRevoke}
        >
          撤销保留
        </button>
      ) : (
        n.impact !== 'related' && (
          <button
            type="button"
            className="ui-btn ui-btn-xs ui-btn-quiet flex-none"
            disabled={busy || !n.inputHash}
            title="先留着现有结果：记下这个决定，不改缓存；输入再变会重新提示"
            onClick={onKeep}
          >
            保留
          </button>
        )
      )}
    </li>
  )
}

function PlanRow({
  source,
  no,
  fields,
  disabled,
  onOpen,
}: {
  source: string
  no: number
  fields: number
  disabled: boolean
  onOpen(): void
}) {
  const description = useId()
  const shot = `镜头 ${String(no).padStart(2, '0')}`
  return (
    <li aria-label={`${source} · ${shot}`} className="flex min-w-0 items-center gap-2 text-sm">
      <div id={description} className="min-w-0 flex-1">
        <p className="truncate text-xs text-ink-muted" title={source}>
          {source}
        </p>
        <p>
          <span className="text-ink">{shot}</span>
          <span className="ml-2 text-xs text-ink-subtle">{fields} 个字段</span>
        </p>
      </div>
      <button
        type="button"
        aria-describedby={description}
        disabled={disabled}
        className="ui-btn ui-btn-sm ui-btn-secondary flex-none"
        onClick={onOpen}
      >
        查看差异
      </button>
    </li>
  )
}

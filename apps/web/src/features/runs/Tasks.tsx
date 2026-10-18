import type { Engine } from '@plein/canvas-core'
import { adoptResult, type PleinDoc } from '@plein/doc'
import { STORYBOARD_TYPE } from '@plein/nodes'
import type { Catalog, GroupInfo, JobInfo, JobList, RecoverJobOptions } from '@plein/protocol'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { findNode } from '../../canvas/nodes'
import {
  clock,
  describeActive,
  describeFailure,
  openProviderSettings,
  RUN_STEPS,
  type RunView,
} from '../../canvas/runStatus'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { duration, relativeTime } from '../../ui/format'
import { Icon } from '../../ui/icons'
import { cancelGroup, cancelNode, runNode } from './run'
import { BATCH_OUTCOME, BATCH_STAGE, CANCELED_BY, describeRecovery } from './recovery'
import { useRecoveryRequests } from './recoveryRequests'
import { cancelRequestKey, useCancelRequests } from './cancelRequests'
import { Presence, useExit } from '../../ui/Presence'
import { EmptyState } from '../../ui/EmptyState'

const STATUS: Record<JobInfo['status'], string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const DOT: Record<JobInfo['status'], string> = {
  queued: 'bg-ink-subtle',
  running: 'bg-accent animate-pulse',
  succeeded: 'bg-success',
  failed: 'bg-danger',
  canceled: 'bg-ink-subtle/50',
}

const isActive = (s: string) => s === 'queued' || s === 'running'

/** 有任务在跑时每秒走一次，已用时长和重试倒计时跟着跳 */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** 文档里排队或运行中的节点数（工具条角标用，不必请求服务端） */
function countActive(doc: PleinDoc) {
  let n = 0
  for (const el of doc.elements()) if (el.run && isActive(el.run.status)) n++
  return n
}

export function useActiveRuns(engine: Engine | null) {
  return useSyncExternalStore(
    (notify) => engine?.doc.subscribe(notify) ?? (() => {}),
    () => (engine ? countActive(engine.doc) : 0),
  )
}

/** 节点运行状态的指纹：变了就该刷新任务列表 */
function runSignature(doc: PleinDoc) {
  const parts: string[] = []
  for (const el of doc.elements()) if (el.run) parts.push(`${el.id}:${el.run.id}:${el.run.status}`)
  return parts.join('|')
}

/** 名称和目标存在状态只更新界面，不触发任务重新读取。 */
function targetSignature(doc: PleinDoc) {
  return JSON.stringify(Array.from(doc.elements(), (el) => [el.id, el.name]))
}

/** 整组运行显示 Frame 名；运行到此处 / 运行下游显示出发的节点 */
function groupName(g: GroupInfo, doc: PleinDoc, catalog: Catalog | null) {
  const el = doc.get(g.frameId)
  if (g.scope === 'frame') return el?.name ?? 'Frame'
  if (g.scope === 'impact')
    return el?.nodeType === STORYBOARD_TYPE
      ? `「${el.name ?? '分镜'}」批量生成`
      : '重做受影响的结果'
  const name = el?.name ?? findNode(catalog, el?.nodeType)?.title ?? '节点'
  return g.scope === 'upstream' ? `运行到「${name}」` : `从「${name}」往下`
}

const hasActive = (list: JobList) =>
  list.jobs.some((j) => isActive(j.status)) || list.groups.some((g) => g.status === 'running')

function closeTasks() {
  useCanvas.getState().toggleTasks(false)
  document.querySelector<HTMLButtonElement>('button[aria-label="任务"]')?.focus()
}

function dismissTasksKey(e: KeyboardEvent) {
  if (
    e.key !== 'Escape' ||
    e.defaultPrevented ||
    e.isComposing ||
    e.keyCode === 229 ||
    document.querySelector('[role="dialog"]')
  )
    return false
  e.preventDefault()
  closeTasks()
  return true
}

/** 右侧任务面板：整组运行、排队和运行中的任务、最近结束的任务 */
export function Tasks() {
  const open = useCanvas((s) => s.tasks)
  const engine = useCanvas((s) => s.engine)
  const canvasId = useCanvas((s) => s.canvasId)
  const catalog = useCatalog((s) => s.catalog)
  const sig = useSyncExternalStore(
    (notify) => engine?.doc.subscribe(notify) ?? (() => {}),
    () => (engine ? runSignature(engine.doc) : ''),
  )
  useSyncExternalStore(
    (notify) => engine?.doc.subscribe(notify) ?? (() => {}),
    () => (engine ? targetSignature(engine.doc) : ''),
  )
  // 打开时轮询：有任务在跑时每秒一次，否则慢一点；节点状态变化（sig）时立即刷新
  const query = useQuery({
    queryKey: queryKeys.canvasJobs(canvasId ?? ''),
    queryFn: () => api.canvasJobs(canvasId!),
    enabled: open && !!canvasId,
    staleTime: 0,
    refetchInterval: (q) =>
      !q.state.error && q.state.data && hasActive(q.state.data) ? 1000 : 5000,
    refetchIntervalInBackground: true,
  })
  const list = query.data ?? null
  const error = query.error?.message
  const now = useNow(open && !!list && hasActive(list))
  const refetch = query.refetch
  // oxlint-disable react-hooks/exhaustive-deps -- sig 变化（节点开始、结束）时重新拉取
  useEffect(() => {
    if (open && canvasId) void refetch({ cancelRefetch: false })
  }, [sig, refetch])
  // oxlint-enable react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      dismissTasksKey(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const { active, done, groups, latest } = useMemo(() => {
    const jobs = list?.jobs ?? []
    // 每个节点最近的一次：失败或取消后仍需按恢复状态决定操作，更早的记录只是历史
    const latest = new Set<string>()
    const seen = new Set<string>()
    for (const j of jobs) {
      if (seen.has(j.nodeId)) continue
      seen.add(j.nodeId)
      latest.add(j.id)
    }
    const all = list?.groups ?? []
    return {
      active: jobs.filter((j) => isActive(j.status)).reverse(),
      done: jobs.filter((j) => !isActive(j.status)),
      groups: [
        ...all.filter((g) => g.status === 'running'),
        ...all.filter((g) => g.status !== 'running').slice(0, 3),
      ],
      latest,
    }
  }, [list])

  if (!engine) return null
  const doc = engine.doc
  const running = active.filter((j) => j.status === 'running').length

  const nameOf = (j: JobInfo) =>
    doc.get(j.nodeId)?.name ?? findNode(catalog, j.nodeType)?.title ?? j.nodeType
  const locate = (id: string) => {
    if (!doc.has(id)) return
    engine.selection.set([id])
    engine.zoomToFit([id])
  }

  return (
    <Presence>
      {open && (
        <Panel
          aria-label="任务"
          onKeyDown={(e) => {
            if (dismissTasksKey(e.nativeEvent)) {
              e.preventDefault()
              e.stopPropagation()
            }
          }}
          className="ui-float ui-pop ui-pop-right pointer-events-auto absolute inset-y-16 right-3 z-30 flex w-90 flex-col rounded-xl max-sm:left-3 max-sm:w-auto"
        >
          <header className="flex h-12 flex-none items-center gap-2 border-b border-line pr-2 pl-4">
            <h2 className="text-sm font-semibold">任务</h2>
            {active.length > 0 && (
              <span className="text-xs text-ink-subtle tabular-nums">
                {[
                  running > 0 && `${running} 个运行中`,
                  active.length - running > 0 && `${active.length - running} 个排队`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            <button
              type="button"
              aria-label="刷新任务"
              title="刷新任务"
              aria-busy={query.isFetching}
              disabled={query.isFetching}
              className="ui-btn ui-btn-quiet ui-icon-btn ml-auto"
              onClick={() => void refetch({ cancelRefetch: false })}
            >
              {query.isFetching ? <span className="ui-spinner size-3" /> : <Icon name="retry" />}
            </button>
            <button
              type="button"
              aria-label="关闭"
              title="关闭（Esc）"
              className="ui-btn ui-btn-quiet ui-icon-btn"
              onClick={closeTasks}
            >
              <Icon name="x" />
            </button>
          </header>
          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {error && (
              <div
                role="alert"
                className="mb-2 flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs"
              >
                <p className="break-words text-danger">
                  {list ? '刷新任务失败' : '读取任务失败'}：{error}
                </p>
                {list && <p className="text-ink-muted">以下仍为上次读取的任务状态。</p>}
                <button
                  type="button"
                  aria-label="重新读取"
                  aria-busy={query.isFetching}
                  disabled={query.isFetching}
                  className="ui-btn ui-btn-secondary ui-btn-xs self-start"
                  onClick={() => void refetch({ cancelRefetch: false })}
                >
                  {query.isFetching ? '正在读取…' : '重新读取'}
                </button>
              </div>
            )}
            {!list ? (
              !error && (
                <p role="status" className="px-2 py-6 text-center text-xs text-ink-subtle">
                  加载任务中…
                </p>
              )
            ) : list.jobs.length === 0 && groups.length === 0 ? (
              <EmptyState
                compact
                icon="tasks"
                title="还没有运行过节点"
                hint="点节点上的「生成」或 Frame 的「整组运行」后，任务会出现在这里。"
              />
            ) : (
              <>
                {groups.length > 0 && (
                  <Section title="批量运行">
                    {groups.map((g) => (
                      <GroupRow
                        key={g.id}
                        group={g}
                        doc={doc}
                        name={groupName(g, doc, catalog)}
                        now={now}
                        onLocate={() => locate(g.frameId)}
                        nameOf={(id) =>
                          doc.get(id)?.name ??
                          findNode(catalog, doc.get(id)?.nodeType)?.title ??
                          '节点'
                        }
                        onLocateNode={locate}
                      />
                    ))}
                  </Section>
                )}
                {active.length > 0 && (
                  <Section title="进行中">
                    {active.map((j) => (
                      <JobRow
                        key={j.id}
                        job={j}
                        doc={doc}
                        name={nameOf(j)}
                        now={now}
                        latest={latest.has(j.id)}
                        onLocate={() => locate(j.nodeId)}
                      />
                    ))}
                  </Section>
                )}
                {done.length > 0 && (
                  <Section title="最近">
                    {done.map((j) => (
                      <JobRow
                        key={j.id}
                        job={j}
                        doc={doc}
                        name={nameOf(j)}
                        now={now}
                        latest={latest.has(j.id)}
                        onLocate={() => locate(j.nodeId)}
                      />
                    ))}
                  </Section>
                )}
              </>
            )}
          </div>
        </Panel>
      )}
    </Presence>
  )
}

/** 面板外框：从右侧滑入，关闭时收回 */
function Panel(props: React.ComponentProps<'aside'>) {
  return <aside {...props} {...useExit()} />
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-2">
      <h3 className="ui-menu-label">{title}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}

function RowButton(props: {
  label: string
  onClick: () => void
  children: React.ReactNode
  busy?: boolean
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-busy={props.busy || undefined}
      disabled={props.busy}
      onClick={props.onClick}
      className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn shrink-0"
    >
      {props.children}
    </button>
  )
}

function JobRow(props: {
  job: JobInfo
  doc: PleinDoc
  name: string
  now: number
  /** 是这个节点最近的一次运行 */
  latest: boolean
  onLocate: () => void
}) {
  const { job, doc, now } = props
  const canvasId = useCanvas((s) => s.canvasId)
  const canceling = useCancelRequests((s) =>
    s.pending.has(cancelRequestKey(canvasId, job.nodeId, job.id)),
  )
  const el = doc.get(job.nodeId)
  // 运行中的阶段、进度和重试只写在文档里，按当前这次运行读
  const run = el?.run?.id === job.id ? el.run : undefined
  const active = isActive(job.status)
  const view = active ? describeActive(run ?? { ...job, at: job.createdAt }, now) : undefined
  // 失败的错误类别只在文档里（最近一次）；更早的记录只有原话
  const recovery = active ? null : describeRecovery(job)
  // 有恢复提示时由它说明现状和处理，不再重复平台的报错
  const failure =
    job.status === 'failed' && !recovery
      ? describeFailure({ error: job.error, errorCode: run?.errorCode })
      : undefined
  let detail =
    job.status === 'canceled' && job.canceledBy ? CANCELED_BY[job.canceledBy] : STATUS[job.status]
  // 不到一秒就结束的（多半是一提交就被拒）不写用时
  if (!active && job.startedAt && job.finishedAt && job.finishedAt - job.startedAt >= 1000)
    detail += ` · 用时 ${duration(job.finishedAt - job.startedAt)}`
  if (!active && job.attempts > 1) detail += ` · 第 ${job.attempts} 次尝试`

  return (
    <li
      data-job-id={job.id}
      className="group flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-hover"
    >
      {view ? (
        <span
          className={`ui-spinner mt-1 size-3 shrink-0 ${view.retrying ? 'text-warning' : job.status === 'queued' ? 'text-ink-subtle' : 'text-accent'}`}
        />
      ) : (
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[job.status]}`} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            disabled={!el}
            onClick={props.onLocate}
            title={el ? '在画布上定位' : '节点已删除'}
            className={`min-w-0 truncate text-left text-sm ${el ? 'hover:underline' : 'text-ink-subtle line-through'}`}
          >
            {props.name}
          </button>
          <span
            className="ml-auto shrink-0 text-2xs text-ink-subtle tabular-nums"
            title={view?.elapsed !== undefined ? '已用时长' : undefined}
          >
            {view?.elapsed !== undefined
              ? clock(view.elapsed)
              : relativeTime(job.finishedAt ?? job.startedAt ?? job.createdAt, now)}
          </span>
        </div>
        {view ? (
          <ActiveDetail view={view} grouped={!!job.groupId} attempt={run?.attempt} />
        ) : (
          <p className="truncate text-xs text-ink-muted">
            {job.groupId && <span className="text-ink-subtle">整组 · </span>}
            {failure ? failure.title : detail}
          </p>
        )}
        {canceling && (
          <p role="status" className="mt-0.5 text-xs text-ink-muted">
            正在停止任务…
          </p>
        )}
        {failure && (
          <>
            {failure.detail && (
              <p className="mt-0.5 line-clamp-2 text-xs text-ink-subtle" title={failure.detail}>
                {failure.detail}
              </p>
            )}
            <p className="mt-0.5 text-2xs text-ink-subtle">{detail}</p>
          </>
        )}
        {recovery && (
          <RecoveryBlock
            job={job}
            view={recovery}
            doc={doc}
            onLocate={props.onLocate}
            latest={props.latest}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {active && (
          <RowButton
            label="停止"
            busy={canceling}
            onClick={() => void cancelNode(job.nodeId, job.id)}
          >
            {canceling ? <span className="ui-spinner size-3" /> : <Icon name="stop" size={14} />}
          </RowButton>
        )}
        {failure?.settings && props.latest && (
          <RowButton label="打开模型平台设置" onClick={openProviderSettings}>
            <Icon name="settings" size={14} />
          </RowButton>
        )}
        {props.latest &&
          el &&
          (!el.run?.id || el.run.id === job.id) &&
          (job.status === 'failed' || job.status === 'canceled') &&
          // 已受理的任务先恢复原结果，输入变化先审查；只有明确失败才直接重试。
          (!job.recovery || job.recovery.state === 'remote_failed') &&
          !isActive(el.run?.status ?? '') && (
            <RowButton label="重试" onClick={() => void runNode(job.nodeId, { retryOf: job.id })}>
              <Icon name="retry" size={14} />
            </RowButton>
          )}
      </div>
    </li>
  )
}

/**
 * 运行中的说明：当前在做什么、调用的平台，下面是四步进度条。
 * 当前这一步知道进度时按进度填满，不知道时一段光来回流动。
 */
function ActiveDetail({
  view,
  grouped,
  attempt,
}: {
  view: RunView
  grouped: boolean
  attempt?: number
}) {
  const tone = view.retrying
    ? 'text-warning'
    : view.step === undefined || view.step === 2
      ? 'text-accent'
      : 'text-ink-muted'
  return (
    <>
      <p className="flex min-w-0 items-baseline gap-1.5 text-xs">
        <span className={`shrink-0 font-medium tabular-nums ${tone}`}>{view.label}</span>
        {view.detail && (
          <span className="truncate text-ink-subtle" title={view.detail}>
            {view.detail}
          </span>
        )}
      </p>
      {view.step !== undefined ? (
        <ol className="ui-run-steps mt-1.5" aria-label="进度">
          {RUN_STEPS.map((name, i) => {
            const state = i < view.step! ? 'done' : i === view.step ? 'now' : 'todo'
            const fill = state === 'now' && view.progress !== undefined ? view.progress : undefined
            return (
              <li key={name} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                <span
                  className="ui-run-step-bar"
                  data-indeterminate={state === 'now' && fill === undefined && !view.retrying}
                >
                  {fill !== undefined && <i style={{ width: `${Math.max(4, fill * 100)}%` }} />}
                </span>
                <span className="ui-run-step-label">{name}</span>
              </li>
            )
          })}
        </ol>
      ) : (
        view.elapsed !== undefined && (
          <div className="ui-run-steps mt-1.5">
            <span className="ui-run-step-bar" data-indeterminate={!view.retrying} />
          </div>
        )
      )}
      {(grouped || (attempt ?? 0) > 1) && (
        <p className="mt-1 text-2xs text-ink-subtle">
          {[grouped && '整组运行', (attempt ?? 0) > 1 && `第 ${attempt} 次尝试`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </>
  )
}

function GroupRow(props: {
  group: GroupInfo
  doc: PleinDoc
  name: string
  now: number
  onLocate: () => void
  nameOf: (id: string) => string
  onLocateNode: (id: string) => void
}) {
  const { group: g, now } = props
  const exists = props.doc.has(g.frameId)
  const [open, setOpen] = useState(false)
  const s = g.summary
  const detail =
    g.status === 'running'
      ? `运行中 · 共 ${g.total} 个节点`
      : [
          g.status === 'canceled' ? '已停止' : '已完成',
          s?.succeeded && `${s.succeeded} 个生成`,
          s?.cached && `${s.cached} 个沿用`,
          s?.failed && `${s.failed} 个失败`,
          s?.canceled && `${s.canceled} 个取消`,
          s?.skipped && `${s.skipped} 个跳过`,
          g.review && `${g.review} 个需重新审查`,
        ]
          .filter(Boolean)
          .join(' · ')
  return (
    <li className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-hover">
      <span className="mt-0.5 shrink-0 text-ink-subtle">
        <Icon name="frame" size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            disabled={!exists}
            onClick={props.onLocate}
            title={exists ? '在画布上定位' : '目标已删除'}
            className={`min-w-0 truncate text-left text-sm ${exists ? 'hover:underline' : 'text-ink-subtle line-through'}`}
          >
            {props.name}
          </button>
          <span className="ml-auto shrink-0 text-2xs text-ink-subtle">
            {relativeTime(g.finishedAt ?? g.createdAt, now)}
          </span>
        </div>
        <p className="truncate text-xs text-ink-muted">{detail}</p>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-2xs text-ink-subtle hover:text-ink hover:underline"
        >
          {open ? '收起批次记录' : '批次记录'}
        </button>
        {open && (
          <BatchItems
            groupId={g.id}
            doc={props.doc}
            nameOf={props.nameOf}
            onLocate={props.onLocateNode}
          />
        )}
      </div>
      {g.status === 'running' && (
        <RowButton label="停止整组" onClick={() => void cancelGroup(g.id)}>
          <Icon name="stop" size={14} />
        </RowButton>
      )}
    </li>
  )
}

/** 批次快照：启动时定下的每个目标、阶段与结局；待解析的依赖和原因 */
function BatchItems(props: {
  groupId: string
  doc: PleinDoc
  nameOf: (id: string) => string
  onLocate: (id: string) => void
}) {
  const query = useQuery({
    queryKey: queryKeys.groupItems(props.groupId),
    queryFn: () => api.groupItems(props.groupId),
    staleTime: 0,
    refetchInterval: (q) => (q.state.error ? 5000 : 2000),
  })
  return (
    <div className="mt-1 space-y-1">
      <div className="flex justify-end">
        <button
          type="button"
          aria-label="刷新批次记录"
          aria-busy={query.isFetching}
          disabled={query.isFetching}
          className="ui-btn ui-btn-quiet ui-btn-xs"
          onClick={() => void query.refetch({ cancelRefetch: false })}
        >
          {query.isFetching ? '正在读取…' : '刷新记录'}
        </button>
      </div>
      {query.error && (
        <div role="alert" className="space-y-1 rounded bg-surface-2 p-2 text-2xs">
          <p className="break-words text-danger">
            {query.data ? '刷新批次记录失败' : '读取批次记录失败'}：{query.error.message}
          </p>
          {query.data && <p className="text-ink-muted">以下仍为上次读取的批次记录。</p>}
          <button
            type="button"
            aria-label="重新读取批次记录"
            aria-busy={query.isFetching}
            disabled={query.isFetching}
            className="ui-btn ui-btn-secondary ui-btn-xs"
            onClick={() => void query.refetch({ cancelRefetch: false })}
          >
            {query.isFetching ? '正在读取…' : '重新读取'}
          </button>
        </div>
      )}
      {!query.data ? (
        !query.error && (
          <p role="status" className="text-2xs text-ink-subtle">
            加载批次记录中…
          </p>
        )
      ) : !query.data.length ? (
        <p className="text-2xs text-ink-subtle">这次运行没有批次记录</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5" aria-label="批次记录">
          {query.data.map((it) => (
            <li key={it.nodeId} className="flex min-w-0 items-baseline gap-1.5 text-2xs">
              <button
                type="button"
                disabled={!props.doc.has(it.nodeId)}
                title={props.doc.has(it.nodeId) ? '在画布上定位' : '节点已删除'}
                onClick={() => props.onLocate(it.nodeId)}
                className={`min-w-0 truncate text-left ${props.doc.has(it.nodeId) ? 'text-ink-muted hover:underline' : 'text-ink-subtle line-through'}`}
              >
                {props.nameOf(it.nodeId)}
              </button>
              <span className="shrink-0 text-ink-subtle">
                {BATCH_STAGE[it.stage]}
                {it.deps.length > 0 && ` · 等 ${it.deps.length} 个上游`}
              </span>
              <span
                className={`ml-auto shrink-0 ${it.outcome === 'review' || it.outcome === 'failed' ? 'text-warning' : 'text-ink-subtle'}`}
                title={it.reason}
              >
                {BATCH_OUTCOME[it.outcome]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 任务的恢复提示与操作：重新获取、人工核查（填任务 ID / 确认未受理后重新提交 / 标记已处理）、
 * 采用待采用的结果、去重新审查
 */
export function RecoveryBlock(props: {
  job: JobInfo
  view: NonNullable<ReturnType<typeof describeRecovery>>
  doc: PleinDoc
  onLocate: () => void
  latest: boolean
}) {
  const { job, view, doc } = props
  const r = job.recovery!
  const canvasId = useCanvas((s) => s.canvasId)
  const client = useQueryClient()
  const requestKey = JSON.stringify([canvasId, job.id])
  const busy = useRecoveryRequests((s) => s.pending.has(requestKey))
  const [attach, setAttach] = useState<string | null>(null)
  const attachTrigger = useRef<HTMLButtonElement>(null)
  const attachInput = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const imeKey = useRef(false)
  const restoreAttachFocus = useRef(false)
  const attachOpen = attach !== null
  useLayoutEffect(() => {
    if (attachOpen) attachInput.current?.focus()
    else if (restoreAttachFocus.current) {
      restoreAttachFocus.current = false
      attachTrigger.current?.focus()
    }
  }, [attachOpen])
  const cancelAttach = () => {
    composing.current = false
    imeKey.current = false
    restoreAttachFocus.current = true
    setAttach(null)
  }
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const el = doc.get(job.nodeId)
  const act = async (body: RecoverJobOptions) => {
    if (!canvasId || !useRecoveryRequests.getState().begin(requestKey)) return
    setError(null)
    try {
      await api.recoverJob(canvasId, job.id, body)
      await client.invalidateQueries({ queryKey: queryKeys.canvasJobs(canvasId) })
      setAttach(null)
      setConfirm(false)
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      const current = useCanvas.getState()
      if (current.canvasId === canvasId) current.notify(message)
    } finally {
      useRecoveryRequests.getState().end(requestKey)
    }
  }
  const pick = r.resultIds?.find((id) => el?.results?.some((x) => x.id === id))
  const tone =
    view.tone === 'warning'
      ? 'text-warning'
      : view.tone === 'danger'
        ? 'text-danger'
        : 'text-ink-muted'
  const btn = 'ui-btn ui-btn-secondary ui-btn-xs'
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="job-recovery">
      <p className={`text-xs ${tone}`}>{view.title}</p>
      {view.detail && <p className="text-2xs text-ink-subtle">{view.detail}</p>}
      {busy && (
        <p role="status" className="text-2xs text-ink-subtle">
          正在处理恢复请求…
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {r.refetchable && (
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => void act({ action: 'refetch' })}
          >
            {r.state === 'submit_unknown' ? '重新核查' : '重新获取'}
          </button>
        )}
        {r.state === 'submit_unknown' && r.attachable && attach === null && (
          <button
            ref={attachTrigger}
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => setAttach('')}
          >
            填写平台任务 ID
          </button>
        )}
        {r.state === 'submit_unknown' && !confirm && (
          <button type="button" className={btn} disabled={busy} onClick={() => setConfirm(true)}>
            确认未受理，重新提交
          </button>
        )}
        {(r.state === 'submit_unknown' ||
          ((r.state === 'fetch_failed' || r.state === 'remote_pending') && !r.refetchable)) && (
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-xs"
            disabled={busy}
            onClick={() => void act({ action: 'dismiss' })}
          >
            标记已处理
          </button>
        )}
        {r.state === 'stored' && el && pick && !doc.readOnly && (
          <button
            type="button"
            className={btn}
            onClick={() => {
              adoptResult(doc, el.id, pick)
              if (canvasId)
                void client.invalidateQueries({ queryKey: queryKeys.canvasJobs(canvasId) })
            }}
          >
            采用
          </button>
        )}
        {r.state === 'review' && el && props.latest && (
          <button type="button" className={btn} onClick={props.onLocate}>
            去审查
          </button>
        )}
      </div>
      {attach !== null && (
        <form
          className="flex gap-1"
          onKeyDown={(e) => {
            if (e.defaultPrevented) return
            imeKey.current =
              composing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
            if (imeKey.current) {
              e.stopPropagation()
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              if (!busy) cancelAttach()
            }
          }}
          onSubmit={(e) => {
            e.preventDefault()
            if (busy || composing.current || imeKey.current) return
            if (attach.trim()) void act({ action: 'attach', remoteId: attach.trim() })
          }}
        >
          <input
            ref={attachInput}
            className="ui-input h-7 min-w-0 flex-1 text-xs"
            placeholder={`${r.provider ?? '平台'}控制台里的任务 ID`}
            aria-label="平台任务 ID"
            disabled={busy}
            value={attach}
            onChange={(e) => setAttach(e.target.value)}
            onCompositionStart={() => {
              composing.current = true
            }}
            onCompositionEnd={() => {
              composing.current = false
            }}
            onBlur={() => {
              composing.current = false
              imeKey.current = false
            }}
          />
          <button type="submit" className={btn} disabled={busy || !attach.trim()}>
            接着取结果
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-xs"
            disabled={busy}
            onClick={cancelAttach}
          >
            取消
          </button>
        </form>
      )}
      {confirm && (
        <div className="flex flex-col gap-1 rounded-md bg-hover px-2 py-1.5">
          <p className="text-2xs text-ink-muted">
            只在确认{r.provider ?? '平台'}
            上没有这次任务时重新提交；平台若其实已受理，会再生成一次、可能重复计费。
          </p>
          <div className="flex gap-1">
            <button
              type="button"
              className="ui-btn ui-btn-danger ui-btn-xs"
              disabled={busy}
              onClick={() => void act({ action: 'resubmit' })}
            >
              重新提交
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-quiet ui-btn-xs"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

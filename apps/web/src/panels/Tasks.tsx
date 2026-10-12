import type { Engine } from '@plein/canvas-core'
import type { PleinDoc } from '@plein/doc'
import type { Catalog, GroupInfo, JobInfo, JobList } from '@plein/protocol'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api } from '../api/client'
import { findNode } from '../canvas/nodes'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { duration, relativeTime } from '../ui/format'
import { Icon } from '../ui/icons'
import { cancelGroup, cancelNode, runNode } from './run'

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

/** 整组运行显示 Frame 名；运行到此处 / 运行下游显示出发的节点 */
function groupName(g: GroupInfo, doc: PleinDoc, catalog: Catalog | null) {
  const el = doc.get(g.frameId)
  if (g.scope === 'frame') return el?.name ?? 'Frame'
  const name = el?.name ?? findNode(catalog, el?.nodeType)?.title ?? '节点'
  return g.scope === 'upstream' ? `运行到「${name}」` : `从「${name}」往下`
}

/** 右侧任务面板：整组运行、排队和运行中的任务、最近结束的任务 */
export function Tasks() {
  const open = useCanvas((s) => s.tasks)
  const engine = useCanvas((s) => s.engine)
  const canvasId = useCanvas((s) => s.canvasId)
  const catalog = useCatalog((s) => s.catalog)
  const [list, setList] = useState<JobList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const sig = useSyncExternalStore(
    (notify) => engine?.doc.subscribe(notify) ?? (() => {}),
    () => (engine ? runSignature(engine.doc) : ''),
  )
  // 打开时轮询：有任务在跑时每秒一次，否则慢一点；节点状态变化时立即刷新
  // biome-ignore lint/correctness/useExhaustiveDependencies: sig 变化（节点开始、结束）时重新拉取
  useEffect(() => {
    if (!open || !canvasId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      clearTimeout(timer)
      try {
        const next = await api.canvasJobs(canvasId)
        if (stopped) return
        setList(next)
        setError(null)
        setNow(Date.now())
        const active =
          next.jobs.some((j) => isActive(j.status)) ||
          next.groups.some((g) => g.status === 'running')
        timer = setTimeout(load, active ? 1000 : 5000)
      } catch (err) {
        if (stopped) return
        setError((err as Error).message)
        timer = setTimeout(load, 5000)
      }
    }
    void load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [open, canvasId, sig])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useCanvas.getState().toggleTasks(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const { active, done, groups, latest } = useMemo(() => {
    const jobs = list?.jobs ?? []
    // 每个节点最近的一次：只有它失败或取消时才给“重试”，更早的记录只是历史
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

  if (!open || !engine) return null
  const doc = engine.doc

  const nameOf = (j: JobInfo) =>
    doc.get(j.nodeId)?.name ?? findNode(catalog, j.nodeType)?.title ?? j.nodeType
  const locate = (id: string) => {
    if (!doc.has(id)) return
    engine.selection.set([id])
    engine.zoomToFit([id])
  }

  return (
    <aside
      aria-label="任务"
      className="ui-float pointer-events-auto absolute inset-y-16 right-3 z-30 flex w-90 flex-col rounded-xl max-sm:left-3 max-sm:w-auto"
    >
      <header className="flex h-12 flex-none items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="text-sm font-semibold">任务</h2>
        {active.length > 0 && (
          <span className="text-xs text-ink-subtle">{active.length} 个排队或运行中</span>
        )}
        <button
          type="button"
          aria-label="关闭"
          title="关闭（Esc）"
          className="ui-btn ui-btn-quiet ui-icon-btn ml-auto"
          onClick={() => useCanvas.getState().toggleTasks(false)}
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {!list ? (
          <p className="px-2 py-6 text-center text-xs text-ink-subtle">
            {error ? `读取任务失败：${error}` : '加载中…'}
          </p>
        ) : list.jobs.length === 0 && groups.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-xs text-ink-subtle">
            <Icon name="tasks" size={24} />
            还没有运行过节点。点节点上的「生成」或 Frame 的「整组运行」后，任务会出现在这里。
          </div>
        ) : (
          <>
            {groups.length > 0 && (
              <Section title="批量运行">
                {groups.map((g) => (
                  <GroupRow
                    key={g.id}
                    group={g}
                    name={groupName(g, doc, catalog)}
                    now={now}
                    onLocate={() => locate(g.frameId)}
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
    </aside>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-2">
      <h3 className="ui-menu-label">{title}</h3>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}

function RowButton(props: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
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
  const el = doc.get(job.nodeId)
  // 运行中的进度和提示（如“N 秒后重试”）只写在文档里，按当前这次运行读
  const run = el?.run?.id === job.id ? el.run : undefined
  const active = isActive(job.status)
  let detail = STATUS[job.status]
  if (job.status === 'running' && run?.progress) detail += ` ${Math.round(run.progress * 100)}%`
  if (active && run?.message) detail = run.message
  if (!active && job.startedAt && job.finishedAt)
    detail += ` · 用时 ${duration(job.finishedAt - job.startedAt)}`
  if (job.attempts > 1) detail += ` · 第 ${job.attempts} 次尝试`

  return (
    <li className="group flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-hover">
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${DOT[job.status]}`} />
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
          <span className="ml-auto shrink-0 text-2xs text-ink-subtle">
            {relativeTime(job.finishedAt ?? job.startedAt ?? job.createdAt, now)}
          </span>
        </div>
        <p className="truncate text-xs text-ink-muted">
          {job.groupId && <span className="text-ink-subtle">整组 · </span>}
          {detail}
        </p>
        {job.status === 'failed' && job.error && (
          <p className="mt-0.5 line-clamp-2 text-xs text-danger" title={job.error}>
            {job.error}
          </p>
        )}
        {job.status === 'running' && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${Math.max(4, (run?.progress ?? 0) * 100)}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {active && (
          <RowButton label="停止" onClick={() => void cancelNode(job.nodeId)}>
            <Icon name="stop" size={14} />
          </RowButton>
        )}
        {props.latest &&
          el &&
          (job.status === 'failed' || job.status === 'canceled') &&
          !isActive(el.run?.status ?? '') && (
            <RowButton label="重试" onClick={() => void runNode(job.nodeId)}>
              <Icon name="retry" size={14} />
            </RowButton>
          )}
      </div>
    </li>
  )
}

function GroupRow(props: { group: GroupInfo; name: string; now: number; onLocate: () => void }) {
  const { group: g, now } = props
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
            onClick={props.onLocate}
            title="在画布上定位"
            className="min-w-0 truncate text-left text-sm hover:underline"
          >
            {props.name}
          </button>
          <span className="ml-auto shrink-0 text-2xs text-ink-subtle">
            {relativeTime(g.finishedAt ?? g.createdAt, now)}
          </span>
        </div>
        <p className="truncate text-xs text-ink-muted">{detail}</p>
      </div>
      {g.status === 'running' && (
        <RowButton label="停止整组" onClick={() => void cancelGroup(g.id)}>
          <Icon name="stop" size={14} />
        </RowButton>
      )}
    </li>
  )
}

import { newId } from '../ids'
import { createHash } from 'node:crypto'
import {
  addResults,
  type CanvasElement,
  createDoc,
  currentResult,
  type NodeResult,
  type NodeRun,
  type PleinDoc,
  type ResultValue,
  setParams,
  SYSTEM_ORIGIN,
  writeRun,
} from '@plein/doc'
import { FlowGraph, runDag, type StepOutcome, stableStringify } from '@plein/flow'
import {
  executionOf,
  type Capability,
  type NodeDefinition,
  type NodeOutputs,
  nodeKey,
  parseModelRef,
  type PortValue,
  ProviderError,
  resolveParams,
} from '@plein/plugin-sdk'
import type {
  FlowRunOptions,
  GroupInfo,
  GroupRunOptions,
  GroupRunStarted,
  GroupRunState,
  JobInfo,
  JobList,
  RunActivity,
  StaleNodes,
} from '@plein/protocol'
import { sleep } from '../plugins/limiter'
import { NodeRunError, type PluginHost, SHUTDOWN } from '../plugins/host'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { applyMentions, mentionEdges } from './mentions'
import { type GroupRow, type JobRow, type JobStatus, JobStore } from './store'

/** 就地计算纯上游节点的最大递归深度（防环） */
const MAX_DEPTH = 8

/** 进度写回文档的最小间隔，避免高频同步 */
const PROGRESS_INTERVAL_MS = 500

/** 调度用的依赖图：画布上的连线，加上提示词里 @ 引用带来的依赖 */
function runGraph(doc: PleinDoc) {
  return new FlowGraph([...doc.edges(), ...mentionEdges(doc)])
}

function toPortValue(v: ResultValue): PortValue {
  if (v.type === 'text' || v.type === 'json') return v
  const out: PortValue = { type: v.type, assetId: v.assetId, kind: v.type, mime: v.mime }
  if (v.caption) out.caption = v.caption
  return out
}

function toResultValue(v: PortValue): ResultValue {
  if (v.type === 'text') return { type: 'text', text: v.text }
  if (v.type === 'json') return { type: 'json', value: v.value }
  const out: ResultValue = { type: v.type, assetId: v.assetId, mime: v.mime }
  if (v.caption) out.caption = v.caption
  return out
}

export interface NodeRunsOptions {
  /** 同时运行的任务数上限（各平台另有自己的并发与频率限制） */
  concurrency?: number
  /** 可重试错误（限流、平台暂不可用、超时）的重试间隔；长度即最多重试次数 */
  retryDelaysMs?: number[]
}

interface ActiveJob {
  id: string
  canvasId: string
  nodeId: string
  ownerId: string
  groupId?: string
  ctrl: AbortController
  started: boolean
  /** 执行器最近报告的进度（0–1） */
  progress?: number
  done: Promise<JobStatus>
  resolve(status: JobStatus): void
}

/** 运行前准备好的输入与缓存键 */
interface Prepared {
  def?: NodeDefinition
  params: Record<string, unknown> | undefined
  inputs: Record<string, PortValue[]>
}

/**
 * 节点运行的任务队列。
 * - 每次运行是 SQLite 里的一条任务，状态和结果写回画布文档，经 Yjs 同步到所有客户端；
 * - 全局并发上限，排不上的任务在队列里等；可重试的错误按间隔自动重试；
 * - 服务退出时不取消远端任务，重启后从调用记录续跑，已完成的模型调用不重复提交；
 * - 整组运行（Frame）在服务端按连线的依赖调度：上游成功才跑下游，上游失败或取消时下游跳过，
 *   参数和输入都没变的节点直接沿用已有结果（缓存）。
 */
export class NodeRuns {
  readonly store: JobStore
  private active = new Map<string, ActiveJob>()
  private byId = new Map<string, ActiveJob>()
  private queue: ActiveJob[] = []
  private running = 0
  private groups = new Map<string, { ctrl: AbortController; canvasId: string }>()
  private closed = false
  private listeners = new Set<(e: RunActivity) => void>()
  private jobsChanged = false
  private concurrency: number
  private retryDelays: number[]

  constructor(
    db: DB,
    private rooms: Rooms,
    private host: PluginHost,
    opts: NodeRunsOptions = {},
  ) {
    this.store = new JobStore(db)
    this.concurrency = Math.max(1, opts.concurrency ?? 4)
    this.retryDelays = opts.retryDelaysMs ?? [2_000, 8_000]
    rooms.onDrop((id) => this.cancelCanvas(id))
  }

  /** 订阅任务动态（桌面端用）；返回取消订阅 */
  onActivity(fn: (e: RunActivity) => void) {
    this.listeners.add(fn)
    // 启动时 recover 已经排上的任务：订阅后马上给一次当前计数
    this.jobsChange()
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(e: RunActivity) {
    if (this.closed) return
    for (const fn of this.listeners) fn(e)
  }

  /** 队列有变化：同一轮里的多次变化合成一条 */
  private jobsChange() {
    if (this.jobsChanged || !this.listeners.size) return
    this.jobsChanged = true
    queueMicrotask(() => {
      this.jobsChanged = false
      const progress = [...this.byId.values()]
        .filter((a) => a.started && a.progress !== undefined)
        .map((a) => a.progress!)
      this.emit({
        type: 'jobs',
        queued: this.queue.length,
        running: this.running,
        progress: progress.length
          ? progress.reduce((sum, p) => sum + p, 0) / progress.length
          : undefined,
      })
    })
  }

  /** 节点名，没有时用节点类型的标题 */
  private titleOf(el: CanvasElement | undefined, fallback: string) {
    if (el?.name) return el.name
    const def = el?.nodeType ? this.host.registry.latestNode(el.nodeType)?.def : undefined
    return def?.title ?? fallback
  }

  private key(canvasId: string, nodeId: string) {
    return `${canvasId}/${nodeId}`
  }

  isRunning(canvasId: string, nodeId: string) {
    return this.active.has(this.key(canvasId, nodeId))
  }

  // ── 单节点 ────────────────────────────────────────

  /** 开始运行（先进队列），立即返回运行 id；校验失败直接抛 NodeRunError */
  start(canvasId: string, nodeId: string, ownerId: string, groupId?: string): string {
    if (this.isRunning(canvasId, nodeId)) throw new NodeRunError('busy', '节点正在运行')
    return this.rooms.withDoc(canvasId, (doc) => {
      const el = doc.get(nodeId)
      if (el?.kind !== 'node' || !el.nodeType) throw new NodeRunError('not_found', '节点不存在')
      const id = newId('run')
      this.store.insert({ id, ownerId, canvasId, nodeId, groupId, nodeType: el.nodeType })
      writeRun(doc, nodeId, { id, status: 'queued', at: Date.now() })
      this.enqueue({ id, canvasId, nodeId, ownerId, groupId })
      return id
    })
  }

  /** 等任务结束，返回最终状态 */
  wait(id: string): Promise<JobStatus> {
    const a = this.byId.get(id)
    if (a) return a.done
    return Promise.resolve(this.store.get(id)?.status ?? 'failed')
  }

  /** 取消；没有在跑的任务（例如服务重启过）时把残留的“运行中”标为已取消 */
  cancel(canvasId: string, nodeId: string) {
    const a = this.active.get(this.key(canvasId, nodeId))
    if (a) {
      if (a.started) a.ctrl.abort()
      else {
        this.queue = this.queue.filter((q) => q !== a)
        this.rooms.withDoc(a.canvasId, (doc) => this.finish(doc, a, 'canceled'))
        this.release(a)
      }
      return
    }
    this.rooms.withDoc(canvasId, (doc) => {
      const run = doc.get(nodeId)?.run
      if (run && (run.status === 'running' || run.status === 'queued')) {
        writeRun(doc, nodeId, { ...run, status: 'canceled', at: Date.now() })
        const job = this.store.get(run.id)
        if (job && (job.status === 'queued' || job.status === 'running'))
          this.store.update(run.id, { status: 'canceled', finished_at: Date.now() })
      }
    })
  }

  /** 画布被删除：停止它的整组运行和所有排队、运行中的任务，不再调用付费平台 */
  cancelCanvas(canvasId: string) {
    for (const g of this.groups.values()) if (g.canvasId === canvasId) g.ctrl.abort()
    for (const a of [...this.byId.values()]) {
      if (a.canvasId !== canvasId) continue
      if (a.started) a.ctrl.abort()
      else {
        this.queue = this.queue.filter((q) => q !== a)
        this.store.update(a.id, { status: 'canceled', finished_at: Date.now() })
        a.resolve('canceled')
        this.release(a)
      }
    }
  }

  // ── 整组 ─────────────────────────────────────────

  /** 需要排队运行、装了执行器的节点；video 为 false 时不含输出视频的节点 */
  private isJobNode(el: CanvasElement | undefined, video = true) {
    if (el?.kind !== 'node' || !el.nodeType) return false
    const def = this.host.registry.latestNode(el.nodeType)?.def
    if (!def || executionOf(def) !== 'job') return false
    if (!this.host.registry.executors.has(nodeKey(def.type, def.version))) return false
    return video || def.outputs[0]?.type !== 'video'
  }

  /** Frame 里要运行的节点；默认不含视频节点 */
  groupTargets(doc: PleinDoc, frameId: string, video: boolean): string[] {
    return doc
      .descendants(frameId)
      .filter((el) => this.isJobNode(el, video))
      .map((el) => el.id)
  }

  /**
   * 从一个节点出发运行，走和整组运行一样的调度与缓存：
   * - upstream（运行到此处）：它和它的上游，没改动的沿用；
   * - downstream（运行下游）：它自己总是重新运行，下游里输入变了的跟着重跑。
   */
  runFlow(
    canvasId: string,
    nodeId: string,
    ownerId: string,
    options: FlowRunOptions,
  ): GroupRunStarted {
    const targets = this.rooms.withDoc(canvasId, (doc) => {
      if (doc.get(nodeId)?.kind !== 'node') throw new NodeRunError('not_found', '节点不存在')
      const graph = runGraph(doc)
      const around =
        options.scope === 'upstream' ? graph.ancestors(nodeId) : graph.descendants(nodeId)
      return [nodeId, ...around].filter((id) => this.isJobNode(doc.get(id)))
    })
    if (targets.length === 0)
      throw new NodeRunError(
        'invalid_input',
        options.scope === 'upstream' ? '这里没有需要运行的节点' : '下游没有需要运行的节点',
      )
    const id = newId('grp')
    const stored: StoredGroupOptions = {
      video: true,
      force: options.force,
      scope: options.scope,
      rerun: options.scope === 'downstream' ? [nodeId] : [],
    }
    this.store.insertGroup({ id, ownerId, canvasId, frameId: nodeId, options: stored, targets })
    void this.orchestrate(this.store.group(id)!)
    return { groupId: id, total: targets.length }
  }

  /**
   * 批量运行一组节点（如分镜编辑器里的「批量出分镜图」）：这些节点总是重新运行；
   * 它们 @ 引用的卡片的上游（连进卡片的定妆图）一起排进来、先跑，已有结果且没改过的沿用。
   * 不带其他上游：剧本、分镜改过也不在这里重跑，免得批量出图悄悄覆盖文本结果。
   */
  runBatch(
    canvasId: string,
    /** 发起批量的元素（分镜节点）：整组的进度和结束提示挂在它上面 */
    sourceId: string,
    nodeIds: string[],
    ownerId: string,
  ): GroupRunStarted {
    const targets = this.rooms.withDoc(canvasId, (doc) => {
      const picked = nodeIds.filter((id) => this.isJobNode(doc.get(id)))
      const mentioned = new FlowGraph(mentionEdges(doc))
      const edges = new FlowGraph(doc.edges())
      const before = new Set<string>()
      for (const id of picked)
        for (const card of mentioned.upstream(id))
          for (const up of edges.ancestors(card)) if (this.isJobNode(doc.get(up))) before.add(up)
      return [...before].filter((id) => !picked.includes(id)).concat(picked)
    })
    if (targets.length === 0) throw new NodeRunError('invalid_input', '没有需要运行的节点')
    const id = newId('grp')
    const stored: StoredGroupOptions = { video: true, force: false, rerun: nodeIds }
    this.store.insertGroup({ id, ownerId, canvasId, frameId: sourceId, options: stored, targets })
    void this.orchestrate(this.store.group(id)!)
    return { groupId: id, total: targets.length }
  }

  /**
   * 需要重跑的节点：当前结果的缓存键和现在算出的不一致的（参数或输入改了），
   * 以及它们下游已有结果的节点。正在运行的不算。
   */
  async staleNodes(canvasId: string, ownerId: string): Promise<StaleNodes> {
    const lease = this.rooms.acquire(canvasId)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    try {
      const signal = new AbortController().signal
      const stale: string[] = []
      for (const el of doc.elements()) {
        if (!this.isJobNode(el) || !el.results?.length || this.isRunning(canvasId, el.id)) continue
        if (!(await this.isFresh(doc, el, ownerId, signal))) stale.push(el.id)
      }
      const graph = runGraph(doc)
      const marked = new Set(stale)
      const upstream: string[] = []
      for (const id of stale) {
        for (const d of graph.descendants(id)) {
          const el = doc.get(d)
          if (marked.has(d) || !this.isJobNode(el) || !el?.results?.length) continue
          if (this.isRunning(canvasId, d)) continue
          marked.add(d)
          upstream.push(d)
        }
      }
      return { stale, upstream }
    } finally {
      doc.destroy()
      lease.release()
    }
  }

  /** 整组运行 Frame：立即返回，进度看各节点状态，结果用 groupState 查询 */
  runGroup(
    canvasId: string,
    frameId: string,
    ownerId: string,
    options: GroupRunOptions,
  ): GroupRunStarted {
    const targets = this.rooms.withDoc(canvasId, (doc) => {
      if (doc.get(frameId)?.kind !== 'frame') throw new NodeRunError('not_found', 'Frame 不存在')
      return this.groupTargets(doc, frameId, options.video)
    })
    const id = newId('grp')
    this.store.insertGroup({ id, ownerId, canvasId, frameId, options, targets })
    void this.orchestrate(this.store.group(id)!)
    return { groupId: id, total: targets.length }
  }

  groupState(id: string, ownerId: string): GroupRunState | null {
    const g = this.store.group(id)
    if (!g || g.owner_id !== ownerId) return null
    return groupState(g)
  }

  /** 任务面板：画布最近的任务和整组运行 */
  list(canvasId: string, limit = 100): JobList {
    return {
      jobs: this.store.recent(canvasId, limit).map(jobInfo),
      groups: this.store.recentGroups(canvasId, 20).map((g): GroupInfo => ({
        ...groupState(g),
        frameId: g.frame_id,
        scope: (JSON.parse(g.options) as StoredGroupOptions).scope ?? 'frame',
        createdAt: g.created_at,
        finishedAt: g.finished_at ?? undefined,
      })),
    }
  }

  /** 取消整组：停止调度，组内正在跑和排队的任务一起取消 */
  cancelGroup(id: string, ownerId: string): boolean {
    const g = this.store.group(id)
    if (!g || g.owner_id !== ownerId) return false
    this.groups.get(id)?.ctrl.abort()
    for (const a of [...this.byId.values()]) {
      if (a.groupId === id) this.cancel(a.canvasId, a.nodeId)
    }
    return true
  }

  private async orchestrate(g: GroupRow) {
    const ctrl = new AbortController()
    this.groups.set(g.id, { ctrl, canvasId: g.canvas_id })
    const options = JSON.parse(g.options) as StoredGroupOptions
    const rerun = new Set(options.rerun ?? [])
    const lease = this.rooms.acquire(g.canvas_id)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    try {
      const targets = (JSON.parse(g.targets) as string[]).filter((id) => doc.get(id))
      const graph = runGraph(doc)
      const step = async (nodeId: string): Promise<StepOutcome> => {
        if (ctrl.signal.aborted) return 'canceled'
        const el = doc.get(nodeId)
        if (!el) return 'failed'
        // 重启后继续：这次整组里已经成功的不再跑
        if (this.store.succeededInGroup(g.id, nodeId)) return 'succeeded'
        let jobId = this.active.get(this.key(g.canvas_id, nodeId))?.id
        if (!jobId) {
          const reuse = !options.force && !rerun.has(nodeId)
          if (reuse && (await this.isFresh(doc, el, g.owner_id, ctrl.signal))) return 'cached'
          // 判断新旧要等一会儿，期间另一组可能已经发起了同一个节点（几组共用一张定妆图）：跟着等它
          jobId =
            this.active.get(this.key(g.canvas_id, nodeId))?.id ??
            this.start(g.canvas_id, nodeId, g.owner_id, g.id)
        }
        const status = await this.wait(jobId)
        if (status === 'succeeded') return 'succeeded'
        return status === 'canceled' ? 'canceled' : 'failed'
      }
      const r = await runDag(graph.dependencies(targets), step, { signal: ctrl.signal })
      if (this.closed) return
      const status = ctrl.signal.aborted ? 'canceled' : 'done'
      const summary = {
        succeeded: r.succeeded.length,
        cached: r.cached.length,
        failed: r.failed.length,
        canceled: r.canceled.length,
        skipped: r.skipped.length,
      }
      this.store.finishGroup(g.id, status, summary)
      this.emit({
        type: 'group-finished',
        canvasId: g.canvas_id,
        frameId: g.frame_id,
        title: this.titleOf(doc.get(g.frame_id), '分组'),
        status,
        summary,
      })
    } finally {
      this.groups.delete(g.id)
      doc.destroy()
      lease.release()
    }
  }

  /**
   * 节点当前采用的结果是否仍然有效：产生它的那次运行的缓存键与现在算出的一致。
   * 早于任务记录的结果（没有对应任务）视为有效，避免升级后整组重跑。
   */
  private async isFresh(doc: PleinDoc, el: CanvasElement, ownerId: string, signal: AbortSignal) {
    const r = currentResult(el)
    if (!r) return false
    const job = this.store.get(r.runId)
    if (!job) return true
    if (job.status !== 'succeeded' || !job.cache_key) return false
    try {
      const prepared = await this.prepare(doc, el, ownerId, signal)
      const omit = job.cache_omit ? (JSON.parse(job.cache_omit) as string[]) : []
      return this.cacheKey(el, prepared, omit) === job.cache_key
    } catch {
      return false
    }
  }

  // ── 启动与退出 ────────────────────────────────────

  /** 服务启动时接着跑上次没结束的任务和整组运行 */
  recover() {
    for (const row of this.store.active()) {
      const ok = this.rooms.withDoc(
        row.canvas_id,
        (doc) => {
          if (doc.get(row.node_id)?.kind !== 'node') return false
          writeRun(doc, row.node_id, {
            id: row.id,
            status: 'queued',
            message: '服务重启后继续',
            at: Date.now(),
          })
          return true
        },
        false,
      )
      if (!ok) {
        this.store.update(row.id, { status: 'canceled', finished_at: Date.now() })
        continue
      }
      this.store.update(row.id, { status: 'queued' })
      this.enqueue({
        id: row.id,
        canvasId: row.canvas_id,
        nodeId: row.node_id,
        ownerId: row.owner_id,
        groupId: row.group_id ?? undefined,
      })
    }
    for (const g of this.store.activeGroups()) void this.orchestrate(g)
  }

  /** 服务退出：停止调度，中止正在跑的任务但保留“运行中”，重启后由 recover 续跑 */
  close() {
    this.closed = true
    this.queue = []
    for (const g of this.groups.values()) g.ctrl.abort()
    for (const a of this.byId.values()) a.ctrl.abort(SHUTDOWN)
  }

  // ── 队列 ─────────────────────────────────────────

  private enqueue(job: Pick<ActiveJob, 'id' | 'canvasId' | 'nodeId' | 'ownerId' | 'groupId'>) {
    let resolve!: (s: JobStatus) => void
    const done = new Promise<JobStatus>((r) => {
      resolve = r
    })
    const a: ActiveJob = { ...job, ctrl: new AbortController(), started: false, done, resolve }
    this.active.set(this.key(a.canvasId, a.nodeId), a)
    this.byId.set(a.id, a)
    this.queue.push(a)
    this.pump()
    this.jobsChange()
  }

  private pump() {
    while (!this.closed && this.running < this.concurrency && this.queue.length) {
      const a = this.queue.shift()!
      a.started = true
      this.running++
      void this.execute(a)
        // 画布刚被删除时拿不到房间：记为取消，不留未处理的 rejection
        .catch(() => a.resolve('canceled'))
        .finally(() => {
          this.running--
          this.release(a)
          this.pump()
        })
    }
  }

  private release(a: ActiveJob) {
    if (this.active.get(this.key(a.canvasId, a.nodeId)) === a)
      this.active.delete(this.key(a.canvasId, a.nodeId))
    this.byId.delete(a.id)
    this.jobsChange()
  }

  private finish(doc: PleinDoc, a: ActiveJob, status: JobStatus, err?: unknown) {
    const at = Date.now()
    const error = err === undefined ? undefined : (err as Error).message
    const errorCode =
      typeof (err as { code?: unknown })?.code === 'string'
        ? (err as { code: string }).code
        : undefined
    this.store.update(a.id, { status, error: error ?? null, finished_at: at })
    const el = doc.get(a.nodeId)
    if (el) writeRun(doc, a.nodeId, { id: a.id, status, error, errorCode, at })
    a.resolve(status)
    this.emit({
      type: 'job-finished',
      canvasId: a.canvasId,
      nodeId: a.nodeId,
      groupId: a.groupId,
      title: this.titleOf(el, '节点'),
      status,
      error,
    })
  }

  private async execute(a: ActiveJob) {
    // 任务可能跑几分钟；持有租约，期间关掉画布标签页也不会卸载文档、丢掉结果
    const lease = this.rooms.acquire(a.canvasId)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    const signal = a.ctrl.signal
    try {
      const el = doc.get(a.nodeId)
      if (el?.kind !== 'node' || !el.nodeType) return this.finish(doc, a, 'canceled')
      const startedAt = Date.now()
      this.store.update(a.id, { status: 'running', started_at: startedAt })
      const base = { id: a.id, status: 'running', startedAt } as const
      writeRun(doc, a.nodeId, { ...base, progress: 0, at: startedAt })

      for (;;) {
        const attempts = (this.store.get(a.id)?.attempts ?? 0) + 1
        this.store.update(a.id, { attempts })
        try {
          await this.runOnce(doc, a, signal, attempts > 1 ? { ...base, attempt: attempts } : base)
          return this.finish(doc, a, 'succeeded')
        } catch (err) {
          if (signal.reason === SHUTDOWN) return a.resolve('running')
          if (signal.aborted) return this.finish(doc, a, 'canceled')
          const delay = this.retryDelays[attempts - 1]
          if (!retryable(err) || delay === undefined) return this.finish(doc, a, 'failed', err)
          const now = Date.now()
          writeRun(doc, a.nodeId, {
            ...base,
            phase: 'retrying',
            message: (err as Error).message,
            retryAt: now + delay,
            attempt: attempts,
            at: now,
          })
          try {
            await sleep(delay, signal)
          } catch {
            if (signal.reason === SHUTDOWN) return a.resolve('running')
            return this.finish(doc, a, 'canceled')
          }
        }
      }
    } catch (err) {
      // 写文档或数据库本身出错：任务记为失败，不让队列卡住
      if (!this.closed) this.finish(doc, a, 'failed', err)
      else a.resolve('failed')
    } finally {
      doc.destroy()
      lease.release()
    }
  }

  /** 执行一次：收集输入、调执行器、写回结果 */
  private async runOnce(
    doc: PleinDoc,
    a: ActiveJob,
    signal: AbortSignal,
    base: Omit<NodeRun, 'at'>,
  ) {
    const el = doc.get(a.nodeId)
    if (!el?.nodeType) throw new NodeRunError('not_found', '节点不存在')
    const prepared = await this.prepare(doc, el, a.ownerId, signal)
    // 运行中的状态：进度、执行器提示和调用平台的阶段合在一起写回文档
    const live: Omit<NodeRun, 'at'> = { ...base }
    let lastProgress = 0
    const outputs = await this.host.runNode({
      type: el.nodeType,
      version: el.nodeVersion ?? 1,
      params: prepared.params,
      inputs: prepared.inputs,
      ownerId: a.ownerId,
      signal,
      journal: this.store.journal(a.id),
      onProgress: (progress, message) => {
        const now = Date.now()
        if (now - lastProgress < PROGRESS_INTERVAL_MS) return
        lastProgress = now
        a.progress = progress
        this.jobsChange()
        Object.assign(live, { progress, message })
        writeRun(doc, el.id, { ...live, at: now })
      },
      // 阶段变化不多，立即写回，界面上排队、生成、下载结果的切换不滞后
      onStage: ({ phase, via }) => {
        if (live.phase === phase && live.via === via) return
        Object.assign(live, { phase, via })
        writeRun(doc, el.id, { ...live, at: Date.now() })
      },
    })
    const at = Date.now()
    const results: NodeResult[] = Object.entries(outputs).flatMap(([port, values]) =>
      values.map((v) => ({ id: newId('res'), port, value: toResultValue(v), runId: a.id, at })),
    )
    addResults(doc, el.id, results)
    const def = prepared.def
    const patch = def?.applyOutputs?.(
      resolveParams(def, doc.get(el.id)?.params, el.nodeVersion ?? def.version),
      outputs,
    )
    if (patch) setParams(doc, el.id, patch)
    // 运行结果写回的参数不计入缓存键，否则节点一跑完就“过期”
    const omit = patch ? Object.keys(patch) : []
    this.store.update(a.id, {
      cache_key: this.cacheKey(el, prepared, omit),
      cache_omit: omit.length ? JSON.stringify(omit) : null,
    })
  }

  /** 收集输入、展开 @ 引用；执行和判断缓存都用它，保证两边算的是同一份东西 */
  private async prepare(
    doc: PleinDoc,
    el: CanvasElement,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<Prepared> {
    const collected = await this.collectInputs(doc, el.id, ownerId, signal)
    const def = this.host.registry.latestNode(el.nodeType!)?.def
    const { params, inputs } = def
      ? await applyMentions(
          doc,
          el,
          def,
          collected,
          (id) => this.collectInputs(doc, id, ownerId, signal),
          this.referenceLimit(el.params?.model, def.capability),
        )
      : { params: el.params, inputs: collected }
    return { def, params, inputs }
  }

  /**
   * 节点要用的模型最多收几张参考图；没选模型时按执行器自动选的那个（同能力排第一的已启用模型）。
   * 没声明上限时不限
   */
  private referenceLimit(model: unknown, capability: string | undefined) {
    if (typeof model === 'string' && model) {
      const ref = parseModelRef(model)
      if (!ref) return undefined
      const entry = this.host.registry.providers.get(ref.provider)
      return entry?.def.models.find((m) => m.id === ref.model)?.limits?.references?.max
    }
    if (!capability) return undefined
    return this.host.models(capability as Capability)[0]?.limits?.references?.max
  }

  /** 节点类型、版本、参数（迁移到最新版本后）和输入的哈希 */
  private cacheKey(el: CanvasElement, p: Prepared, omit: string[]) {
    let params: Record<string, unknown> | undefined = p.params
    if (p.def) {
      try {
        params = resolveParams(p.def, p.params, el.nodeVersion ?? p.def.version)
      } catch {}
    }
    const kept = cacheParams(params ?? {}, omit)
    return createHash('sha256')
      .update(
        stableStringify({
          type: el.nodeType,
          version: p.def?.version ?? el.nodeVersion,
          params: kept,
          // 来源元素 id 只用来对应设置，不算内容
          inputs: Object.fromEntries(
            Object.entries(p.inputs).map(([k, vs]) => [k, vs.map(({ source: _, ...v }) => v)]),
          ),
        }),
      )
      .digest('hex')
  }

  /**
   * 按输入端口收集上游值：节点取当前采用的结果，素材元素取资产，Markdown 取正文。
   * 上游是还没结果的纯节点（不调模型，如文本节点）时就地计算。
   * 同一端口的多个上游按画布位置从上到下、从左到右排序。
   */
  private async collectInputs(
    doc: PleinDoc,
    nodeId: string,
    ownerId: string,
    signal: AbortSignal,
    depth = 0,
  ): Promise<Record<string, PortValue[]>> {
    if (depth > MAX_DEPTH) throw new NodeRunError('invalid_input', '上游连线成环或层级过深')
    const edges = [...doc.edges()].filter((e) => e.to[0] === nodeId)
    const pos = (id: string) => doc.worldRect(id) ?? { x: 0, y: 0 }
    edges.sort((a, b) => {
      const pa = pos(a.from[0])
      const pb = pos(b.from[0])
      return pa.y - pb.y || pa.x - pb.x
    })
    const inputs: Record<string, PortValue[]> = {}
    for (const edge of edges) {
      const src = doc.get(edge.from[0])
      if (!src) continue
      const values = await this.upstreamValues(doc, src, edge.from[1], ownerId, signal, depth)
      const tagged = values.map((v) => ({ ...v, source: src.id }))
      inputs[edge.to[1]] = [...(inputs[edge.to[1]] ?? []), ...tagged]
    }
    return inputs
  }

  private async upstreamValues(
    doc: PleinDoc,
    src: CanvasElement,
    port: string,
    ownerId: string,
    signal: AbortSignal,
    depth: number,
  ): Promise<PortValue[]> {
    const label = src.name ?? '上游'
    switch (src.kind) {
      case 'markdown':
        return src.text?.trim() ? [{ type: 'text', text: src.text }] : []
      case 'image':
      case 'video':
      case 'audio':
        return src.assetId ? [{ type: src.kind, assetId: src.assetId, kind: src.kind }] : []
      case 'node': {
        const r = currentResult(src, port)
        if (r) return [toPortValue(r.value)]
        const def = src.nodeType ? this.host.registry.latestNode(src.nodeType)?.def : undefined
        if (def && executionOf(def) === 'inline') {
          const out: NodeOutputs = await this.host.runNode({
            type: src.nodeType!,
            version: src.nodeVersion ?? 1,
            params: src.params,
            inputs: await this.collectInputs(doc, src.id, ownerId, signal, depth + 1),
            ownerId,
            signal,
          })
          return out[port] ?? []
        }
        throw new NodeRunError('missing_input', `上游节点「${label}」还没有结果，请先运行它`)
      }
      default:
        return []
    }
  }
}

/** 限流、平台暂不可用、超时这类错误重试可能成功 */
function retryable(err: unknown) {
  return (err instanceof NodeRunError || err instanceof ProviderError) && err.retryable
}

export type { JobRow }

/** 存在 job_groups.options 里的设置：整组运行的选项，加上运行到此处 / 运行下游的范围 */
interface StoredGroupOptions extends GroupRunOptions {
  scope?: 'upstream' | 'downstream'
  /** 不看缓存、总是重新运行的节点 */
  rerun?: string[]
}

function groupState(g: GroupRow): GroupRunState {
  return {
    id: g.id,
    status: g.status,
    total: (JSON.parse(g.targets) as string[]).length,
    summary: g.summary ? JSON.parse(g.summary) : undefined,
  }
}

function jobInfo(j: JobRow): JobInfo {
  return {
    id: j.id,
    nodeId: j.node_id,
    nodeType: j.node_type,
    groupId: j.group_id ?? undefined,
    status: j.status,
    attempts: j.attempts,
    error: j.error ?? undefined,
    createdAt: j.created_at,
    startedAt: j.started_at ?? undefined,
    finishedAt: j.finished_at ?? undefined,
  }
}

/**
 * 计入缓存键的参数：
 * - 运行结果写回的参数（omit）不算；
 * - 模型专属参数只算所选模型那份，别的模型的设置改了不影响；
 * - 后加参数取中性值（分辨率留空、语速 1 倍、专属参数为空）时不算：加之前生成的结果不必因此重跑。
 */
const NEUTRAL: Record<string, unknown> = { resolution: '', speed: 1 }

export function cacheParams(params: Record<string, unknown>, omit: string[] = []) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (omit.includes(k)) continue
    if (k in NEUTRAL && NEUTRAL[k] === v) continue
    if (k === 'options' && v && typeof v === 'object' && typeof params.model === 'string') {
      const own = (v as Record<string, Record<string, unknown> | undefined>)[params.model]
      if (own && Object.keys(own).length) out[k] = own
      continue
    }
    out[k] = v
  }
  return out
}

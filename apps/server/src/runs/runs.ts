import { imageProcessParams, videoModeProblem, type VideoMode } from '@plein/nodes'
import { speechDirection, speechVoice } from '../executors/audio'
import {
  appendDeliveryRecord,
  freezeDeliveryOrigins,
  type DeliveryOrigins,
} from '../executors/delivery'
import { newId } from '../ids'
import { createHash } from 'node:crypto'
import {
  addResults,
  adoptResult,
  type CanvasElement,
  createDoc,
  currentResult,
  inputEdges,
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
  type NodeDefinition,
  type NodeOutputs,
  nodeKey,
  parseModelRef,
  type PortValue,
  ProviderError,
  resolveParams,
} from '@plein/plugin-sdk'
import { hasVoice, voiceOf } from '@plein/nodes'
import type {
  BatchItem,
  FlowRunOptions,
  GroupInfo,
  HeldReason,
  ImpactRunOptions,
  GroupRunOptions,
  GroupRunStarted,
  GroupRunState,
  InputValue,
  JobInfo,
  JobList,
  LatestNodeJobs,
  PreparedInput,
  RecoverJobOptions,
  RunActivity,
  StaleNodes,
} from '@plein/protocol'
import { PREPARED_INPUT_VERSION } from '@plein/protocol'
import { sleep } from '../plugins/limiter'
import { type CallRecord, NodeRunError, type PluginHost, SHUTDOWN, stageOf } from '../plugins/host'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { fillModels } from './models'
import { type AppliedMentions, applyMentions, mentionEdges } from './mentions'
import { type GroupRow, type JobRow, type JobStatus, JobStore } from './store'
import {
  type BatchHost,
  batchItem,
  expectOf,
  type JobExpect,
  outcomeOf,
  parseExpect,
  planChange,
  snapshotBatch,
} from './batch'
import {
  canceledByOf,
  describeRecovery,
  modelOf,
  parseCalls,
  parseRecovery,
  type ProviderAbility,
  recoveryAfter,
  reviewError,
  type StoredRecovery,
  SYSTEM_CANCEL,
  USER_CANCEL,
} from './recovery'

/** 就地计算纯上游节点的最大递归深度（防环） */
const MAX_DEPTH = 8

/** 进度写回文档的最小间隔，避免高频同步 */
const PROGRESS_INTERVAL_MS = 500

/** 任务的取消事实保留在历史里；已取回并入库的具体结果仍可按输入键沿用。 */
function reusableResult(job: JobRow, resultId: string): boolean {
  if (job.status === 'succeeded') return true
  if (job.status !== 'canceled') return false
  const recovery = parseRecovery(job.recovery)
  return (
    (recovery.state === 'stored' || recovery.state === 'adopted') &&
    !!recovery.resultIds?.includes(resultId)
  )
}

/** 调度用的依赖图：画布上的连线，加上提示词里 @ 引用带来的依赖 */
export function runGraph(doc: PleinDoc) {
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
  /** 恢复操作（重新获取、核查后续查）发起的：节点上已有更新的运行时不改它的运行状态 */
  quiet?: boolean
  /** 结果一律只进候选历史（用户取消过的任务取回的结果） */
  held?: HeldReason
}

/** 提交时冻结的参数与输入值（jobs.frozen） */
interface Frozen {
  params: Record<string, unknown> | undefined
  inputs: Record<string, PortValue[]>
  inputHash?: string
  deliveryOrigins?: DeliveryOrigins
}

function parseFrozen(raw: string | null | undefined): Frozen | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as Frozen
  } catch {
    return undefined
  }
}

/** 运行前准备好的输入；缓存键、实际输入预览和提交都由它算出 */
interface Prepared {
  def?: NodeDefinition
  params: Record<string, unknown> | undefined
  inputs: Record<string, PortValue[]>
  /** @ 引用的实际用法、降级提示与阻断原因；节点没有声明时为空 */
  mentions?: Pick<AppliedMentions, 'details' | 'notices' | 'blocked'>
  /** 每个输入值对应的上游结果；按值保留，避免同一节点的多个输出端口相互覆盖 */
  origins?: WeakMap<PortValue, Origin>
}

interface Origin {
  resultId: string
  runId: string
}

/** 缓存键的算法版本；算法变了递增，旧键由 legacyCacheKey 兼容比对 */
const CACHE_KEY_VERSION = 'v2:'

/** 检查一个节点得到的东西：实际输入摘要、收集到的输入值与迁移后的参数 */
export interface Inspection {
  input: PreparedInput
  inputs: Record<string, PortValue[]>
  params: Record<string, unknown>
  /**
   * 某次任务的结果是否按这份输入生成：缓存键一致（任务写回的参数不计入，
   * 无前缀的旧键按旧算法比，与 isFresh 相同）；准备不过去时总是 false
   */
  matches(job: Pick<JobRow, 'cache_key' | 'cache_omit'>): boolean
}

/** 输入里的长文本在实际输入摘要里只留开头 */
const TEXT_PREVIEW = 2_000

/**
 * 节点运行的任务队列。
 * - 每次运行是 SQLite 里的一条任务，状态和结果写回画布文档，经 Yjs 同步到所有客户端；
 * - 全局并发上限，排不上的任务在队列里等；可重试的错误按间隔自动重试；
 * - 服务退出时不取消远端任务，重启后从调用记录续跑，已完成的模型调用不重复提交；
 * - 整组运行（Frame）在服务端按连线的依赖调度：上游成功才跑下游，上游失败或取消时下游跳过，
 *   参数和输入都没变的节点直接沿用已有结果（缓存）。
 */
export class NodeRuns implements BatchHost {
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
    readonly rooms: Rooms,
    private host: PluginHost,
    opts: NodeRunsOptions = {},
  ) {
    this.store = new JobStore(db)
    this.concurrency = Math.max(1, opts.concurrency ?? 4)
    this.retryDelays = opts.retryDelaysMs ?? [2_000, 8_000]
    rooms.onDrop((id) => this.cancelCanvas(id))
    rooms.onLoad((id) => rooms.withDoc(id, (doc) => fillModels(doc, host)))
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
  start(
    canvasId: string,
    nodeId: string,
    ownerId: string,
    groupId?: string,
    /** 批准的计划：执行前重新准备，对不上就不提交（见 JobExpect） */
    expect?: JobExpect,
    retryOf?: string,
  ): string {
    if (this.isRunning(canvasId, nodeId)) throw new NodeRunError('busy', '节点正在运行')
    return this.rooms.withDoc(canvasId, (doc) => {
      const el = doc.get(nodeId)
      if (el?.kind !== 'node' || !el.nodeType) throw new NodeRunError('not_found', '节点不存在')
      const previous = this.store.latestForNodes(canvasId, [nodeId])[0]
      const recovery = previous && this.jobInfo(previous, doc).recovery
      if (
        retryOf &&
        (previous?.id !== retryOf ||
          !['failed', 'canceled'].includes(previous.status) ||
          (el.run?.id && el.run.id !== retryOf) ||
          (recovery && recovery.state !== 'remote_failed'))
      )
        throw new NodeRunError('run_changed', '任务已变化，旧重试请求未执行')
      if (
        recovery &&
        !recovery.dismissed &&
        ['submit_unknown', 'remote_pending', 'fetch_failed'].includes(recovery.state)
      )
        throw new NodeRunError('recovery_required', '原任务尚待核查或取回，请先恢复或标记已处理')
      const id = newId('run')
      this.store.insert({
        id,
        ownerId,
        canvasId,
        nodeId,
        groupId,
        nodeType: el.nodeType,
        ...(expect ? { expect: JSON.stringify(expect) } : {}),
      })
      writeRun(doc, nodeId, { id, status: 'queued', at: Date.now() })
      this.enqueue({ id, canvasId, nodeId, ownerId, groupId })
      return id
    })
  }

  /**
   * 用户确认过实际输入后开始运行：重新准备，与确认时的 inputHash 不同就不运行，
   * 返回新的实际输入（changed）让界面展示差异；一致或没带 expect 时同 start。
   * 确认的哈希随任务存下，排队期间输入又变了，执行前复核时不提交
   */
  async startChecked(
    canvasId: string,
    nodeId: string,
    ownerId: string,
    expect?: string,
    retryOf?: string,
  ): Promise<{ runId: string } | { changed: PreparedInput }> {
    if (expect) {
      const now = await this.preview(canvasId, nodeId, ownerId)
      if (!now.inputHash || now.inputHash !== expect) return { changed: now }
    }
    return {
      runId: this.start(
        canvasId,
        nodeId,
        ownerId,
        undefined,
        expect ? { inputHash: expect } : undefined,
        retryOf,
      ),
    }
  }

  /** 节点的实际输入：最终提示词、参考图及顺序、音色、模型与有效参数；不调用付费生成 */
  async preview(canvasId: string, nodeId: string, ownerId: string): Promise<PreparedInput> {
    const lease = this.rooms.acquire(canvasId)
    const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
    try {
      const el = doc.get(nodeId)
      if (el?.kind !== 'node' || !el.nodeType) throw new NodeRunError('not_found', '节点不存在')
      return (await this.inspect(doc, el, ownerId, new AbortController().signal)).input
    } finally {
      doc.destroy()
      lease.release()
    }
  }

  // ── 影响分析用（见 impact.ts）────────────────────────

  /**
   * 准备节点的输入并整理成摘要，不调用付费生成。
   * 准备不过去时仍从这份文档给出部分摘要，不给 inputHash，也不匹配任何任务。
   * 修改方案传入的是文档副本，不能重新打开原画布来取得失败摘要
   */
  async inspect(
    doc: PleinDoc,
    el: CanvasElement,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<Inspection> {
    let prepared: Prepared
    try {
      prepared = await this.prepare(doc, el, ownerId, signal)
    } catch (err) {
      if (!(err instanceof NodeRunError)) throw err
      const def = el.nodeType ? this.host.registry.latestNode(el.nodeType)?.def : undefined
      const { inputHash: _, ...base } = this.summarize(el, { def, params: el.params, inputs: {} })
      return {
        input: {
          ...base,
          status: 'unprepared',
          blocked: [{ code: 'prepare_failed', message: err.message }, ...base.blocked],
        },
        inputs: {},
        params: el.params ?? {},
        matches: () => false,
      }
    }
    return {
      input: this.summarize(el, prepared),
      inputs: prepared.inputs,
      params: this.latestParams(el, prepared) ?? {},
      matches: (job) => this.keyMatches(el, prepared, job),
    }
  }

  /**
   * 已有候选里按现在的输入生成过的那个（不含当前采用的）：重做时直接改用它，不调用平台。
   * 撤销修改后旧候选就又对得上了
   */
  cachedCandidate(el: CanvasElement, inspection: Inspection): string | undefined {
    const cur = currentResult(el)
    if (!cur) return undefined
    const candidates = (el.results ?? []).filter((r) => r.port === cur.port && r.id !== cur.id)
    const jobs = new Map(
      this.store.many([...new Set(candidates.map((r) => r.runId))]).map((j) => [j.id, j]),
    )
    return candidates.find((r) => {
      const job = jobs.get(r.runId)
      return !!job && reusableResult(job, r.id) && inspection.matches(job)
    })?.id
  }

  /**
   * 当前采用的结果是否按这份输入生成：产生它的那次运行的缓存键与现在的一致。
   * 早于任务记录的结果（没有对应任务）视为有效，与 isFresh 相同
   */
  resultMatches(el: CanvasElement, inspection: Inspection): boolean {
    const r = currentResult(el)
    if (!r) return false
    const job = this.store.get(r.runId)
    if (!job) return true
    return reusableResult(job, r.id) && inspection.matches(job)
  }

  // ── 批次快照用（见 batch.ts）────────────────────────

  /** 节点自身参数与实际模型的哈希（不含输入）：上游还没出结果时据此判断计划有没有变 */
  planKey(el: CanvasElement): string {
    const def = el.nodeType ? this.host.registry.latestNode(el.nodeType)?.def : undefined
    return this.cacheKey(el, { def, params: el.params, inputs: {} }, [])
  }

  /** 批次快照：整组运行启动时定下的目标、阶段、批准的输入与结局 */
  batchItems(groupId: string, ownerId: string): BatchItem[] | null {
    const g = this.store.group(groupId)
    if (!g || g.owner_id !== ownerId) return null
    return this.store.batchItems(groupId).map(batchItem)
  }

  /** 模型配的每次提交费用；没配时为空 */
  priceOf(model: PreparedInput['model']) {
    const ref = model && parseModelRef(model.ref)
    if (!ref) return undefined
    return this.host.registry.providers
      .get(ref.provider)
      ?.def.models.find((m) => m.id === ref.model)?.price
  }

  /** 参数的显示名（节点声明里的 title），没有时用键名 */
  paramTitle(nodeType: string, key: string): string {
    const def = this.host.registry.latestNode(nodeType)?.def
    const shape = (def?.params as { shape?: Record<string, { meta?(): unknown }> } | undefined)
      ?.shape
    const meta = shape?.[key]?.meta?.() as { title?: string } | undefined
    return meta?.title ?? key
  }

  // ─────────────────────────────────────────────

  /** 把准备结果整理成给人看、也存进执行记录的实际输入 */
  private summarize(el: CanvasElement, p: Prepared): PreparedInput {
    const def = p.def
    const params = this.latestParams(el, p) ?? {}
    const promptKey = ['prompt', 'text'].find((k) => typeof params[k] === 'string')
    const upstreamText = (p.inputs[promptKey ?? 'prompt'] ?? []).flatMap((v) =>
      v.type === 'text' ? [v.text] : v.type === 'json' ? [JSON.stringify(v.value)] : [],
    )
    const prompt = promptKey
      ? [String(params[promptKey]).trim(), upstreamText.join('\n').trim()]
          .filter(Boolean)
          .join('\n\n')
      : undefined
    const shown = cacheParams(params)
    for (const k of [
      promptKey,
      'usedRefs',
      'requiredRefs',
      'continuesFrom',
      'shotPresets',
      'voice',
    ])
      if (k) delete shown[k]
    const voice = voiceOf(params)
    const model = this.resolveModel(params.model)
    const limit = model?.limit
    const blocked = p.mentions?.blocked ?? []
    return {
      v: PREPARED_INPUT_VERSION,
      nodeId: el.id,
      nodeType: el.nodeType!,
      ...(def ? { nodeVersion: def.version } : {}),
      preparedAt: Date.now(),
      status: blocked.length ? 'blocked' : 'ready',
      capability: def?.capability,
      ...(model
        ? {
            model: {
              ref: model.ref,
              provider: model.provider,
              title: model.title,
              ...(model.version ? { version: model.version } : {}),
            },
          }
        : {}),
      ...(limit === undefined ? {} : { referenceLimit: limit }),
      ...(prompt === undefined ? {} : { prompt }),
      params: shown,
      inputs: Object.fromEntries(
        Object.entries(p.inputs).map(([port, values]) => [
          port,
          values.map((v) => inputValue(v, p.origins?.get(v))),
        ]),
      ),
      refs: p.mentions?.details ?? [],
      ...(def?.capability === 'audio.speech' && hasVoice(voice)
        ? { voice: { provider: voice.provider, voiceId: voice.voiceId } }
        : {}),
      notices: p.mentions?.notices ?? [],
      blocked,
      inputHash: this.cacheKey(el, p, []),
    }
  }

  /**
   * 节点选的模型（不替用户挑，没选时为空），带上参考图上限、平台声明的模型版本和平台插件版本，
   * 供预览和缓存键用
   */
  private resolveModel(model: unknown) {
    if (typeof model !== 'string' || !model) return undefined
    const parsed = parseModelRef(model)
    const entry = parsed ? this.host.registry.providers.get(parsed.provider) : undefined
    const spec = entry?.def.models.find((m) => m.id === parsed!.model)
    return {
      ref: model,
      provider: parsed?.provider ?? '',
      title: spec?.title ?? model,
      version: spec?.version,
      limit: spec?.limits?.references?.max,
      plugin: entry ? this.host.registry.plugin(entry.plugin)?.manifest.version : undefined,
    }
  }

  /** 等任务结束，返回最终状态 */
  wait(id: string): Promise<JobStatus> {
    const a = this.byId.get(id)
    if (a) return a.done
    return Promise.resolve(this.store.get(id)?.status ?? 'failed')
  }

  /** 取消；没有在跑的任务（例如服务重启过）时把残留的“运行中”标为已取消 */
  cancel(canvasId: string, nodeId: string, expectedRunId?: string) {
    const a = this.active.get(this.key(canvasId, nodeId))
    if (expectedRunId) {
      const current = a?.id ?? this.rooms.withDoc(canvasId, (doc) => doc.get(nodeId)?.run?.id)
      if (current !== expectedRunId)
        throw new NodeRunError('run_changed', '此节点已开始其他任务，旧停止请求未执行')
    }
    if (a) {
      if (a.started) a.ctrl.abort(USER_CANCEL)
      else {
        this.queue = this.queue.filter((q) => q !== a)
        this.rooms.withDoc(a.canvasId, (doc) =>
          this.finish(doc, a, 'canceled', undefined, { canceledBy: 'user' }),
        )
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
          this.store.update(run.id, {
            status: 'canceled',
            finished_at: Date.now(),
            recovery: JSON.stringify(
              recoveryAfter('canceled', undefined, parseCalls(job.calls), { canceledBy: 'user' }),
            ),
          })
      }
    })
  }

  /** 画布被删除：停止它的整组运行和所有排队、运行中的任务，不再调用付费平台 */
  cancelCanvas(canvasId: string) {
    for (const g of this.groups.values()) if (g.canvasId === canvasId) g.ctrl.abort()
    for (const a of [...this.byId.values()]) {
      if (a.canvasId !== canvasId) continue
      if (a.started) a.ctrl.abort(SYSTEM_CANCEL)
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
  isJobNode(el: CanvasElement | undefined, video = true) {
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

  /** 按已审阅清单精确排队，不再隐式扩大目标；批准输入和依赖随组持久化。 */
  runReviewedBatch(
    canvasId: string,
    sourceId: string,
    ownerId: string,
    items: Array<{ nodeId: string; input: PreparedInput; expect: JobExpect }>,
  ): GroupRunStarted {
    if (!items.length) throw new NodeRunError('invalid_input', '清单中没有需要生成的项目')
    const id = newId('grp')
    const now = Date.now()
    const targets = items.map((item) => item.nodeId)
    this.store.insertApprovedGroup(
      {
        id,
        ownerId,
        canvasId,
        frameId: sourceId,
        options: { video: true, force: false, scope: 'impact', rerun: targets },
        targets,
      },
      items.map((item, seq) => ({
        group_id: id,
        node_id: item.nodeId,
        seq,
        stage: 'run',
        reason: null,
        input_hash: item.expect.inputHash ?? null,
        plan_hash: item.expect.planHash ?? null,
        deps: JSON.stringify(item.expect.deps ?? []),
        input: JSON.stringify(item.input),
        frozen_hash: null,
        job_id: null,
        outcome: 'pending',
        result_id: null,
        updated_at: now,
      })),
    )
    void this.orchestrate(this.store.group(id)!)
    return { groupId: id, total: targets.length }
  }

  /**
   * 只运行在「查看影响」里勾选的节点，按依赖先后调度，不带它们的上下游。
   * 现在的结果还有效的沿用；已有候选里有按现在的输入生成过的直接改用它（如撤销修改之后），
   * 都不调用平台；force 时勾选的全部重新生成。
   */
  runImpact(canvasId: string, ownerId: string, options: ImpactRunOptions): GroupRunStarted {
    const targets = this.rooms.withDoc(canvasId, (doc) =>
      [...new Set(options.nodes)].filter((id) => this.isJobNode(doc.get(id))),
    )
    if (targets.length === 0) throw new NodeRunError('invalid_input', '没有需要运行的节点')
    const id = newId('grp')
    const stored: StoredGroupOptions = {
      video: true,
      force: options.force,
      scope: 'impact',
      candidates: !options.force,
    }
    this.store.insertGroup({
      id,
      ownerId,
      canvasId,
      frameId: targets[0]!,
      options: stored,
      targets,
    })
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
      const kept: string[] = []
      for (const id of [...stale, ...upstream]) {
        const el = doc.get(id)
        if (el && (await this.isKept(canvasId, doc, el, ownerId, signal))) kept.push(id)
      }
      return { stale, upstream, kept }
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
    const rows = this.store.recent(canvasId, limit)
    // 候选有没有被采用要看画布；画布读不出来时不给这部分
    const jobs =
      this.rooms.withDoc(canvasId, (doc) => rows.map((r) => this.jobInfo(r, doc)), null) ??
      rows.map((r) => this.jobInfo(r))
    const groups = this.store.recentGroups(canvasId, 20)
    const review = this.store.reviewCounts(groups.map((g) => g.id))
    return {
      jobs,
      groups: groups.map((g): GroupInfo => ({
        ...groupState(g),
        frameId: g.frame_id,
        scope: (JSON.parse(g.options) as StoredGroupOptions).scope ?? 'frame',
        ...(review.get(g.id) ? { review: review.get(g.id) } : {}),
        createdAt: g.created_at,
        finishedAt: g.finished_at ?? undefined,
      })),
    }
  }

  latestForNodes(canvasId: string, nodes: readonly string[]): LatestNodeJobs {
    const rows = this.store.latestForNodes(canvasId, nodes)
    return {
      jobs:
        this.rooms.withDoc(canvasId, (doc) => rows.map((row) => this.jobInfo(row, doc)), null) ??
        rows.map((row) => this.jobInfo(row)),
    }
  }

  /** 任务面板里的一条：执行记录加上恢复状态 */
  jobInfo(row: JobRow, doc?: PleinDoc): JobInfo {
    const model = modelOf(row)
    return { ...jobInfo(row), ...describeRecovery(row, { doc, provider: this.abilityOf(model) }) }
  }

  /** 平台在恢复上的能力：能不能按任务 ID 查询、有没有查询或幂等合同 */
  private abilityOf(ref: string | undefined): ProviderAbility | undefined {
    const parsed = ref ? parseModelRef(ref) : undefined
    const def = parsed ? this.host.registry.providers.get(parsed.provider)?.def : undefined
    if (!def) return undefined
    return { title: def.title, poll: !!def.poll, verify: !!def.lookup || !!def.idempotent }
  }

  // ── 任务恢复 ─────────────────────────────────────

  /**
   * 处理一个需要恢复的任务（见 RecoverJobOptions）：重新获取、填任务 ID 续查、核查后重新提交、
   * 标记已处理。都按提交时冻结的输入执行；返回处理后的任务，任务不存在时返回 null
   */
  recoverJob(
    canvasId: string,
    jobId: string,
    ownerId: string,
    opt: RecoverJobOptions,
  ): JobInfo | null {
    const row = this.store.get(jobId)
    if (!row || row.canvas_id !== canvasId || row.owner_id !== ownerId) return null
    const view = this.rooms.withDoc(canvasId, (doc) => this.jobInfo(row, doc))
    const rec = view.recovery
    const stored = parseRecovery(row.recovery)
    if (opt.action === 'dismiss') {
      this.store.update(jobId, { recovery: JSON.stringify({ ...stored, dismissed: true }) })
      return this.jobInfo(this.store.get(jobId)!)
    }
    if (this.isRunning(canvasId, row.node_id))
      throw new NodeRunError('busy', '节点正在运行，等它结束后再处理')
    const calls = JSON.parse(row.calls || '{}') as Record<string, CallRecord>
    const unknown = Object.keys(calls).filter(
      (k) => calls[k]!.state === 'unknown' || calls[k]!.state === 'submitting',
    )
    const journal = this.store.journal(jobId)
    if (opt.action === 'refetch') {
      if (!rec?.refetchable)
        throw new NodeRunError('invalid_input', rec?.note ?? '这个任务没有可以重新获取的结果')
    } else {
      if (rec?.state !== 'submit_unknown' || !unknown.length)
        throw new NodeRunError('invalid_input', '这个任务的提交状态不是未知')
      if (opt.action === 'attach') {
        if (!rec.attachable || !row.frozen)
          throw new NodeRunError('invalid_input', '这个平台不支持按任务 ID 查询，无法接着取结果')
        journal.set(unknown[0]!, { state: 'pending', remoteId: opt.remoteId })
      } else for (const k of unknown) journal.delete(k)
    }
    this.resume(row, stored)
    return this.jobInfo(this.store.get(jobId)!)
  }

  /** 按调用记录重新执行一个已结束的任务（不新建任务，结果和费用都记在原任务上） */
  private resume(row: JobRow, stored: StoredRecovery) {
    const canceled = stored.canceledBy === 'user' || row.status === 'canceled'
    this.store.update(row.id, {
      status: 'queued',
      error: null,
      finished_at: null,
      recovery: stored.canceledBy ? JSON.stringify({ canceledBy: stored.canceledBy }) : null,
    })
    this.enqueue({
      id: row.id,
      canvasId: row.canvas_id,
      nodeId: row.node_id,
      ownerId: row.owner_id,
      groupId: row.group_id ?? undefined,
      quiet: true,
      ...(canceled ? { held: 'canceled' as const } : {}),
    })
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
      // 批次快照：启动时（重启后继续时已经有了）定下每个目标的阶段、批准的输入和待解析依赖
      if (!this.store.batchItems(g.id).length)
        await snapshotBatch(
          this,
          g,
          doc,
          targets,
          graph,
          {
            force: options.force,
            rerun,
            // 用户确认保留的结果也按沿用记（按影响运行时除外）
            kept:
              options.scope === 'impact'
                ? undefined
                : (el) => this.isKept(g.canvas_id, doc, el, g.owner_id, ctrl.signal),
          },
          ctrl.signal,
        ).catch(() => {})
      const settle = (nodeId: string, outcome: BatchItem['outcome'], resultId?: string) =>
        this.store.updateBatchItem(g.id, nodeId, {
          outcome,
          ...(resultId ? { result_id: resultId } : {}),
        })
      const step = async (nodeId: string): Promise<StepOutcome> => {
        if (ctrl.signal.aborted) return 'canceled'
        const el = doc.get(nodeId)
        if (!el) {
          this.store.updateBatchItem(g.id, nodeId, { outcome: 'failed', reason: '节点已删除' })
          return 'failed'
        }
        // 重启后继续：这次整组里已经成功的不再跑
        if (this.store.succeededInGroup(g.id, nodeId)) return 'succeeded'
        let jobId = this.active.get(this.key(g.canvas_id, nodeId))?.id
        if (!jobId) {
          const reuse = !options.force && !rerun.has(nodeId)
          if (reuse && (await this.isFresh(doc, el, g.owner_id, ctrl.signal))) {
            settle(nodeId, 'cached', currentResult(el)?.id)
            return 'cached'
          }
          // 用户确认保留的过期结果：整组运行不花钱重跑；在「查看影响」里勾选了才重做
          if (
            reuse &&
            options.scope !== 'impact' &&
            (await this.isKept(g.canvas_id, doc, el, g.owner_id, ctrl.signal))
          ) {
            settle(nodeId, 'cached', currentResult(el)?.id)
            return 'cached'
          }
          if (options.candidates && reuse) {
            const now = await this.inspect(doc, el, g.owner_id, ctrl.signal)
            const hit = this.cachedCandidate(el, now)
            if (hit) {
              adoptResult(doc, nodeId, hit)
              settle(nodeId, 'cached', hit)
              return 'cached'
            }
          }
          // 判断新旧要等一会儿，期间另一组可能已经发起了同一个节点（几组共用一张定妆图）：跟着等它
          const item = this.store.batchItem(g.id, nodeId)
          jobId =
            this.active.get(this.key(g.canvas_id, nodeId))?.id ??
            this.start(g.canvas_id, nodeId, g.owner_id, g.id, item ? expectOf(item) : undefined)
          this.store.updateBatchItem(g.id, nodeId, { job_id: jobId, outcome: 'running' })
        }
        const status = await this.wait(jobId)
        const outcome = outcomeOf(this.store.get(jobId))
        const now = doc.get(nodeId)
        settle(nodeId, outcome, outcome === 'succeeded' && now ? currentResult(now)?.id : undefined)
        if (status === 'succeeded') return 'succeeded'
        return status === 'canceled' ? 'canceled' : 'failed'
      }
      // @ 引用带来的依赖是软的：参考图出不来（比如被平台审核拦下）时，镜头只带文字设定照常出
      const deps = graph.dependencies(targets)
      const hard = new FlowGraph(doc.edges()).dependencies(targets)
      const soft = new Map(
        [...deps].map(([id, ups]) => [id, new Set([...ups].filter((u) => !hard.get(id)?.has(u)))]),
      )
      const r = await runDag(hard, step, { signal: ctrl.signal, soft })
      if (this.closed) return
      for (const id of r.skipped)
        this.store.updateBatchItem(g.id, id, {
          outcome: 'skipped',
          reason: '上游失败或取消，没有运行',
        })
      for (const id of r.canceled)
        if (this.store.batchItem(g.id, id)?.outcome === 'pending')
          this.store.updateBatchItem(g.id, id, { outcome: 'canceled' })
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
   * 用户在「查看影响」里确认保留了当前结果：决定时的输入和采用的结果都还是现在这样才算。
   * 不改缓存有效性，结果仍算过期；整组运行据此不重跑它，按影响运行时勾选了照样重做
   */
  private async isKept(
    canvasId: string,
    doc: PleinDoc,
    el: CanvasElement,
    ownerId: string,
    signal: AbortSignal,
  ) {
    const d = this.store.decisions(canvasId).find((x) => x.node_id === el.id && !x.revoked_at)
    if (!d || currentResult(el)?.id !== d.result_id) return false
    const now = await this.inspect(doc, el, ownerId, signal)
    return now.input.inputHash === d.input_hash
  }

  /**
   * 节点当前采用的结果是否仍然有效：产生它的那次运行的缓存键与现在算出的一致。
   * 早于任务记录的结果（没有对应任务）视为有效，避免升级后整组重跑。
   */
  async isFresh(doc: PleinDoc, el: CanvasElement, ownerId: string, signal: AbortSignal) {
    const r = currentResult(el)
    if (!r) return false
    const job = this.store.get(r.runId)
    if (!job) return true
    if (!reusableResult(job, r.id) || !job.cache_key) return false
    try {
      const prepared = await this.prepare(doc, el, ownerId, signal)
      return this.keyMatches(el, prepared, job)
    } catch {
      return false
    }
  }

  // ── 启动与退出 ────────────────────────────────────

  /** 服务启动时接着跑上次没结束的任务和整组运行 */
  recover() {
    for (const row of this.store.active()) {
      // 用户取消过、又去取回结果的任务：照旧只进候选，不动节点上更新的运行状态
      const canceled = parseRecovery(row.recovery).canceledBy === 'user'
      const ok = this.rooms.withDoc(
        row.canvas_id,
        (doc) => {
          const el = doc.get(row.node_id)
          if (el?.kind !== 'node') return false
          if (!el.run || el.run.id === row.id)
            writeRun(doc, row.node_id, {
              id: row.id,
              status: 'queued',
              message: '服务重启后继续',
              at: Date.now(),
            })
          return { quiet: !!el.run && el.run.id !== row.id }
        },
        false,
      )
      if (!ok) {
        this.store.update(row.id, {
          status: 'canceled',
          finished_at: Date.now(),
          recovery: JSON.stringify(
            recoveryAfter('canceled', undefined, parseCalls(row.calls), { canceledBy: 'system' }),
          ),
        })
        continue
      }
      this.store.update(row.id, { status: 'queued' })
      this.enqueue({
        id: row.id,
        canvasId: row.canvas_id,
        nodeId: row.node_id,
        ownerId: row.owner_id,
        groupId: row.group_id ?? undefined,
        ...(ok.quiet || canceled ? { quiet: true } : {}),
        ...(canceled ? { held: 'canceled' as const } : {}),
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

  private enqueue(
    job: Pick<ActiveJob, 'id' | 'canvasId' | 'nodeId' | 'ownerId' | 'groupId' | 'quiet' | 'held'>,
  ) {
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

  private finish(
    doc: PleinDoc,
    a: ActiveJob,
    status: JobStatus,
    err?: unknown,
    extra?: StoredRecovery,
  ) {
    const at = Date.now()
    const error = err === undefined ? undefined : (err as Error).message
    // 提交状态未知、保存失败按步骤给原因，不按平台错误码（那只是表面的网络错误）
    const stage = stageOf(err)
    const errorCode =
      stage === 'submit_unknown' || stage === 'fetch_failed'
        ? stage
        : typeof (err as { code?: unknown })?.code === 'string'
          ? (err as { code: string }).code
          : undefined
    const recovery = recoveryAfter(status, err, parseCalls(this.store.get(a.id)?.calls), extra)
    this.store.update(a.id, {
      status,
      error: error ?? null,
      finished_at: at,
      recovery: recovery ? JSON.stringify(recovery) : null,
    })
    const el = doc.get(a.nodeId)
    if (el && (!a.quiet || el.run?.id === a.id || !el.run))
      writeRun(doc, a.nodeId, { id: a.id, status, error, errorCode, at })
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
      if (el?.kind !== 'node' || !el.nodeType)
        return this.finish(doc, a, 'canceled', undefined, { canceledBy: 'system' })
      const startedAt = Date.now()
      this.store.update(a.id, { status: 'running', started_at: startedAt })
      const base = { id: a.id, status: 'running', startedAt } as const
      // 恢复操作发起的：节点上已经有更新的运行时不动它的状态
      const own = !a.quiet || !el.run || el.run.id === a.id
      if (own) writeRun(doc, a.nodeId, { ...base, progress: 0, at: startedAt })

      for (;;) {
        const attempts = (this.store.get(a.id)?.attempts ?? 0) + 1
        this.store.update(a.id, { attempts })
        try {
          const done = await this.runOnce(
            doc,
            a,
            signal,
            attempts > 1 ? { ...base, attempt: attempts } : base,
            own,
          )
          // 取消后才返回的结果：入库待采用，任务仍算已取消
          if (done.held === 'canceled')
            return this.finish(doc, a, 'canceled', undefined, {
              ...done,
              canceledBy: canceledByOf(signal.reason),
            })
          return this.finish(doc, a, 'succeeded', undefined, done)
        } catch (err) {
          if (signal.reason === SHUTDOWN) return a.resolve('running')
          if (signal.aborted)
            return this.finish(doc, a, 'canceled', err, { canceledBy: canceledByOf(signal.reason) })
          if (stageOf(err) === 'remote_canceled')
            return this.finish(
              doc,
              a,
              'canceled',
              err,
              a.held === 'canceled' ? { canceledBy: 'user' } : undefined,
            )
          const delay = this.retryDelays[attempts - 1]
          if (!retryable(err) || delay === undefined) return this.finish(doc, a, 'failed', err)
          const now = Date.now()
          if (own)
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
            return this.finish(doc, a, 'canceled', err, { canceledBy: canceledByOf(signal.reason) })
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

  /**
   * 执行一次：收集输入、核对批准的计划、冻结输入、调执行器、写回结果。
   * 已经调用过平台（重启、重试、重新获取）时按冻结的输入接着做，不再读画布：
   * 输入改过也不会让调用对不上记录而重新提交。返回结果是否被采用
   */
  private async runOnce(
    doc: PleinDoc,
    a: ActiveJob,
    signal: AbortSignal,
    base: Omit<NodeRun, 'at'>,
    own = true,
  ): Promise<StoredRecovery & { held?: HeldReason }> {
    const el = doc.get(a.nodeId)
    if (!el?.nodeType) throw new NodeRunError('not_found', '节点不存在')
    const row = this.store.get(a.id)
    const def = this.host.registry.latestNode(el.nodeType)?.def
    let frozen = parseFrozen(row?.frozen)
    if (!frozen || !parseCalls(row?.calls).length) {
      const prepared = await this.prepare(doc, el, a.ownerId, signal)
      // 实际输入随任务存下来：降级、舍弃的参考图和所用模型以后查得到
      const input = this.summarize(el, prepared)
      this.store.update(a.id, { input: JSON.stringify(input) })
      // 付费节点：实际输入相对批准的计划变了（排队期间改过、批次里上游换了来源）就不提交
      const expect = parseExpect(row?.expect)
      if (expect && def?.capability) {
        const reason = planChange(
          expect,
          { inputHash: input.inputHash, planHash: this.planKey(el) },
          { doc, groupId: a.groupId, store: this.store },
        )
        if (reason) throw reviewError(reason)
      }
      // 必需参考用不上：不提交，免得花钱生成一张缺了关键角色或道具的图
      if (input.blocked.length)
        throw new NodeRunError('invalid_input', input.blocked.map((b) => b.message).join('；'))
      frozen = {
        params: prepared.params,
        inputs: prepared.inputs,
        inputHash: input.inputHash,
        ...(['plein/sequence', 'plein/animatic'].includes(el.nodeType)
          ? { deliveryOrigins: freezeDeliveryOrigins(doc, prepared.inputs) }
          : {}),
      }
      this.store.update(a.id, { frozen: JSON.stringify(frozen) })
      if (a.groupId)
        this.store.updateBatchItem(a.groupId, a.nodeId, { frozen_hash: input.inputHash ?? null })
    }
    const prepared: Prepared = { def, params: frozen.params, inputs: frozen.inputs }
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
        if (own) writeRun(doc, el.id, { ...live, at: now })
      },
      // 阶段变化不多，立即写回，界面上排队、生成、下载结果的切换不滞后
      onStage: ({ phase, via }) => {
        if (live.phase === phase && live.via === via) return
        Object.assign(live, { phase, via })
        if (own) writeRun(doc, el.id, { ...live, at: Date.now() })
      },
    })
    const at = Date.now()
    const results: NodeResult[] = Object.entries(outputs).flatMap(([port, values]) =>
      values.map((v) => ({
        id: newId('res'),
        port,
        value: toResultValue(v),
        runId: a.id,
        at,
        ...(typeof v.outputGroup === 'string' && v.outputGroup
          ? { outputGroup: v.outputGroup }
          : {}),
      })),
    )
    // 运行结果写回的参数不计入缓存键，否则节点一跑完就“过期”
    const patchFor = () => {
      const now = doc.get(el.id)
      return def?.applyOutputs?.(
        resolveParams(def, now?.params, el.nodeVersion ?? def.version),
        outputs,
      )
    }
    const held = await this.heldReason(doc, a, el, frozen.inputHash, row?.created_at ?? 0, signal)
    const resultIds = results.map((r) => r.id)
    if (held === 'node_deleted') {
      // 节点没了：产物只留在执行记录里
      const assets = results.flatMap((r) => ('assetId' in r.value ? [r.value.assetId] : []))
      this.store.update(a.id, { cache_key: this.cacheKey(el, prepared, []) })
      return { state: 'stored', held, assets }
    }
    addResults(doc, el.id, results, { adopt: !held })
    appendDeliveryRecord(
      doc,
      el.id,
      results,
      frozen.params,
      frozen.inputs,
      (id) => this.host.assetInfo(a.ownerId, id),
      frozen.deliveryOrigins ?? {},
    )
    const patch = held ? undefined : patchFor()
    if (patch) setParams(doc, el.id, patch)
    const omit = patch ? Object.keys(patch) : []
    this.store.update(a.id, {
      cache_key: this.cacheKey(el, prepared, omit),
      cache_omit: omit.length ? JSON.stringify(omit) : null,
    })
    return held ? { state: 'stored', held, resultIds } : { state: 'adopted', resultIds }
  }

  /**
   * 晚返回的结果能不能成为当前结果：用户取消过、节点删了、节点有更新的运行、
   * 或输入在提交后改过，都只进候选历史，返回原因；可以采用时返回 undefined
   */
  private async heldReason(
    doc: PleinDoc,
    a: ActiveJob,
    el: CanvasElement,
    inputHash: string | undefined,
    createdAt: number,
    signal: AbortSignal,
  ): Promise<HeldReason | undefined> {
    if (a.held) return a.held
    if (signal.aborted && signal.reason !== SHUTDOWN) return 'canceled'
    const now = doc.get(el.id)
    if (!now) return 'node_deleted'
    if (this.store.newerJobs(a.canvasId, el.id, createdAt).length) return 'superseded'
    if (!inputHash) return undefined
    try {
      const p = await this.prepare(doc, now, a.ownerId, new AbortController().signal)
      return this.cacheKey(now, p, []) === inputHash ? undefined : 'input_changed'
    } catch {
      return 'input_changed'
    }
  }

  /** 收集输入、展开 @ 引用；执行和判断缓存都用它，保证两边算的是同一份东西 */
  private async prepare(
    doc: PleinDoc,
    el: CanvasElement,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<Prepared> {
    const origins = new WeakMap<PortValue, Origin>()
    const collected = await this.collectInputs(doc, el.id, ownerId, signal, 0, origins)
    const def = this.host.registry.latestNode(el.nodeType!)?.def
    if (!def) return { def, params: el.params, inputs: collected, origins }
    const { params, inputs, details, notices, blocked } = await applyMentions(
      doc,
      el,
      def,
      collected,
      // @ 引用是软依赖：卡片的参考图节点还没结果（生成失败、被审核拦下）时只附文字设定
      (id) => this.collectInputs(doc, id, ownerId, signal, 0, origins, true),
      this.resolveModel(el.params?.model)?.limit,
    )
    const modelRef = typeof params.model === 'string' ? parseModelRef(params.model) : null
    const spec =
      modelRef &&
      this.host.registry.providers
        .get(modelRef.provider)
        ?.def.models.find((m) => m.id === modelRef.model)
    const limits = spec?.limits
    const effective = this.latestParams(el, { def, params, inputs }) ?? {}
    if (
      (def.capability === 'image.generate' || def.capability === 'video.generate') &&
      effective.resolution &&
      limits?.resolutions?.length &&
      !limits.resolutions.includes(String(effective.resolution))
    )
      blocked.push({
        code: 'prepare_failed',
        message: `${spec?.title ?? '当前模型'} 不支持分辨率 ${String(effective.resolution)}；请选择 ${limits.resolutions.join('、')}，或使用默认分辨率`,
      })
    if (def.capability === 'audio.speech') {
      const check = speechVoice(String(effective.model ?? ''), voiceOf(effective))
      if (check.problem) blocked.push({ code: 'prepare_failed', message: check.problem })
      if (check.notice && !notices.some((n) => n.code === 'voice_unverified'))
        notices.push({ code: 'voice_unverified', message: check.notice })
      const model = String(effective.model ?? '')
      const options = effective.options as Record<string, Record<string, unknown>> | undefined
      try {
        speechDirection(
          model,
          String(effective.instruction ?? ''),
          options?.[model] ?? {},
          spec || undefined,
        )
      } catch (err) {
        if (!(err instanceof ProviderError) || err.code !== 'invalid_input') throw err
        blocked.push({ code: 'prepare_failed', message: err.message })
      }
    }
    if (def.capability === 'video.generate') {
      const images = inputs.images?.length ?? 0
      const videos = inputs.videos?.length ?? 0
      const audios = inputs.audios?.length ?? 0
      const mode = String(effective.mode ?? 'text') as VideoMode
      const problem = videoModeProblem(
        mode,
        mode === 'reference' ? images + videos + audios : images,
      )
      if (problem) blocked.push({ code: 'prepare_failed', message: problem })
      if (mode === 'reference' && limits?.references && images > limits.references.max)
        blocked.push({
          code: 'prepare_failed',
          message: `当前模型最多支持 ${limits.references.max} 张参考图，现在连了 ${images} 张`,
        })
      if (mode !== 'reference' && (videos || audios))
        blocked.push({ code: 'prepare_failed', message: '视频和音频参考需要选择多模态参考模式' })
      if (
        videos > ((limits && limits.referenceMedia?.video) || 0) ||
        audios > ((limits && limits.referenceMedia?.audio) || 0)
      )
        blocked.push({
          code: 'prepare_failed',
          message: '当前模型不支持这些参考素材或数量超过上限',
        })
    }
    if (
      def.capability === 'image.process' &&
      !(
        limits &&
        limits.imageOperations?.includes(effective.operation as 'upscale' | 'outpaint' | 'cutout')
      )
    )
      blocked.push({ code: 'prepare_failed', message: '当前模型不支持这项精修操作' })
    if (
      def.capability === 'image.process' &&
      inputs.image?.filter((v) => v.type === 'image').length !== 1
    )
      blocked.push({ code: 'prepare_failed', message: '图片精修需要连入一张原图' })
    const orderedInputs = Object.fromEntries([
      ...def.inputs.filter((port) => inputs[port.id]).map((port) => [port.id, inputs[port.id]!]),
      ...Object.entries(inputs).filter(([id]) => !def.inputs.some((port) => port.id === id)),
    ])
    return { def, params, inputs: orderedInputs, mentions: { details, notices, blocked }, origins }
  }

  /**
   * 缓存键：节点类型与版本、所选模型及其版本、平台插件版本、
   * 有效参数（迁移到最新版本后）和输入内容的哈希，带算法版本前缀
   */
  private cacheKey(el: CanvasElement, p: Prepared, omit: string[]) {
    const model = this.resolveModel(this.latestParams(el, p)?.model)
    return (
      CACHE_KEY_VERSION +
      this.hashKey(el, p, omit, NOT_CONTENT, {
        model: model ? { ref: model.ref, version: model.version, plugin: model.plugin } : null,
      })
    )
  }

  /**
   * 某次任务的缓存键是否和现在的输入对得上。以前模型留空时按「自动选中的模型」算键，
   * 模型参数后来补成了同一个模型的，按留空的参数再算一次也认
   */
  private keyMatches(
    el: CanvasElement,
    p: Prepared,
    job: Pick<JobRow, 'cache_key' | 'cache_omit'>,
  ): boolean {
    if (!job.cache_key) return false
    const omit = job.cache_omit ? (JSON.parse(job.cache_omit) as string[]) : []
    if (!job.cache_key.startsWith(CACHE_KEY_VERSION))
      return this.legacyCacheKey(el, p, omit) === job.cache_key
    if (this.cacheKey(el, p, omit) === job.cache_key) return true
    const params = this.latestParams(el, p)
    const model = this.resolveModel(params?.model)
    if (!model) return false
    const extra = { model: { ref: model.ref, version: model.version, plugin: model.plugin } }
    const auto = { ...params, model: '' }
    return CACHE_KEY_VERSION + this.hashKey(el, p, omit, NOT_CONTENT, extra, auto) === job.cache_key
  }

  /** 加前缀之前的缓存键：不含实际模型与插件版本，usedRefs 计入；只用来认旧任务的结果 */
  private legacyCacheKey(el: CanvasElement, p: Prepared, omit: string[]) {
    return this.hashKey(el, p, omit, LEGACY_NOT_CONTENT, {})
  }

  private latestParams(el: CanvasElement, p: Prepared) {
    if (!p.def) return p.params
    try {
      const params = resolveParams(p.def, p.params, el.nodeVersion ?? p.def.version)
      return p.def.capability === 'image.process' ? imageProcessParams(params) : params
    } catch {
      return p.params
    }
  }

  private hashKey(
    el: CanvasElement,
    p: Prepared,
    omit: string[],
    notContent: ReadonlySet<string>,
    extra: Record<string, unknown>,
    params = this.latestParams(el, p) ?? {},
  ) {
    const kept = cacheParams(params, omit, notContent)
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
          ...extra,
        }),
      )
      .digest('hex')
  }

  /**
   * 按输入端口收集上游值：节点取当前采用的结果，素材元素取资产，Markdown 取正文。
   * 上游是还没结果的纯节点（不调模型，如文本节点）时就地计算。
   * 同一端口的多个上游按文档中的稳定顺序排序，布局不改变输入。
   */
  private async collectInputs(
    doc: PleinDoc,
    nodeId: string,
    ownerId: string,
    signal: AbortSignal,
    depth = 0,
    origins?: WeakMap<PortValue, Origin>,
    /** 上游节点没有结果时当作没有值，而不是报错 */
    lenient = false,
  ): Promise<Record<string, PortValue[]>> {
    if (depth > MAX_DEPTH) throw new NodeRunError('invalid_input', '上游连线成环或层级过深')
    const edges = inputEdges(doc, nodeId)
    const inputs: Record<string, PortValue[]> = {}
    for (const edge of edges) {
      const src = doc.get(edge.from[0])
      if (!src) continue
      const values = await this.upstreamValues(
        doc,
        src,
        edge.from[1],
        ownerId,
        signal,
        depth,
        lenient,
      )
      const r = src.kind === 'node' ? currentResult(src, edge.from[1]) : undefined
      const tagged = values.map((v) => ({ ...v, source: src.id }))
      if (r && origins) for (const v of tagged) origins.set(v, { resultId: r.id, runId: r.runId })
      const port = (inputs[edge.to[1]] ??= [])
      for (const v of tagged) port.push(v)
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
    lenient = false,
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
            inputs: await this.collectInputs(
              doc,
              src.id,
              ownerId,
              signal,
              depth + 1,
              undefined,
              lenient,
            ),
            ownerId,
            signal,
          })
          return out[port] ?? []
        }
        if (lenient) return []
        if (src.adopted === null && src.results?.length)
          throw new NodeRunError(
            'missing_input',
            `上游节点「${label}」有候选待采用，请先查看并采用结果`,
          )
        if (currentResult(src)) {
          const output = src.ports?.outputs.find((p) => p.id === port)?.label ?? port
          throw new NodeRunError(
            'missing_input',
            `上游节点「${label}」当前候选没有可确认的「${output}」输出，请检查所选候选`,
          )
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
  scope?: 'upstream' | 'downstream' | 'impact'
  /** 不看缓存、总是重新运行的节点 */
  rerun?: string[]
  /** 结果过期时先找按现在的输入生成过的候选，有就改用它（按影响运行） */
  candidates?: boolean
}

function groupState(g: GroupRow): GroupRunState {
  return {
    id: g.id,
    status: g.status,
    total: (JSON.parse(g.targets) as string[]).length,
    summary: g.summary ? JSON.parse(g.summary) : undefined,
  }
}

function inputValue(v: PortValue, origin?: Origin): InputValue {
  const meta = { ...(v.source ? { source: v.source } : {}), ...origin }
  const text = (t: string) =>
    t.length > TEXT_PREVIEW
      ? { text: t.slice(0, TEXT_PREVIEW), truncated: true as const }
      : { text: t }
  if (v.type === 'text') return { type: 'text', ...text(v.text), ...meta }
  if (v.type === 'json') return { type: 'json', ...text(JSON.stringify(v.value)), ...meta }
  return { type: v.type, assetId: v.assetId, ...meta }
}

function parseInput(raw: string | null): PreparedInput | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as PreparedInput
  } catch {
    return undefined
  }
}

function jobInfo(j: JobRow): JobInfo {
  const input = parseInput(j.input)
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
    ...(input ? { input } : {}),
  }
}

/**
 * 计入缓存键的参数：
 * - 运行结果写回的参数（omit）不算；
 * - 模型专属参数只算所选模型那份，别的模型的设置改了不影响；
 * - 后加参数取中性值（分辨率留空、语速 1 倍、专属参数为空）时不算：加之前生成的结果不必因此重跑。
 */
const NEUTRAL: Record<string, unknown> = { resolution: '', speed: 1 }
/**
 * 不影响送进模型内容的设置：必需参考只决定怎么取舍，usedRefs 是取舍结果的描述，
 * 两者的效果都已经体现在实际输入里
 */
const NOT_CONTENT: ReadonlySet<string> = new Set([
  'requiredRefs',
  'usedRefs',
  'continuesFrom',
  'shotPresets',
])
const LEGACY_NOT_CONTENT: ReadonlySet<string> = new Set([
  'requiredRefs',
  'continuesFrom',
  'shotPresets',
])

export function cacheParams(
  params: Record<string, unknown>,
  omit: string[] = [],
  notContent: ReadonlySet<string> = NOT_CONTENT,
) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (omit.includes(k) || notContent.has(k)) continue
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

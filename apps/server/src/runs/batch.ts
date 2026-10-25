import { type CanvasElement, createDoc, currentResult, type PleinDoc } from '@plein/doc'
import { createHash } from 'node:crypto'
import { stableStringify } from '@plein/flow'
import type {
  BatchDependency,
  BatchItem,
  BatchOutcome,
  BatchStage,
  PreparedInput,
  StoryboardAudioSource,
} from '@plein/protocol'
import type { FlowGraph } from '@plein/flow'
import * as Y from 'yjs'
import { parseRecovery } from './recovery'
import type { Inspection } from './runs'
import type { BatchItemRow, JobRow, JobStore } from './store'

/**
 * 批准的计划：执行前重新准备，与它对不上就不提交（付费节点），记为需要重新审查。
 * - inputHash：用户确认过的实际输入（单节点生成时的 expect，或批次启动时就能算出的输入）
 * - planHash + deps：上游也在本批次里还要重新生成时，输入要到提交前才定下来；
 *   只核对节点自身的参数与模型，以及上游的结果是不是本批次产生的（或启动时那个）
 */
export interface JobExpect {
  inputHash?: string
  planHash?: string
  deps?: BatchDependency[]
  sequenceScope?: {
    canvasId: string
    boardId: string
    sequenceId: string
    shotIds: string[]
    clipInstanceIds: string[]
    audioSources?: StoryboardAudioSource[]
  }
}

interface StoredReviewedInput {
  kind: 'plein-reviewed-sequence-input'
  version: 1
  input: PreparedInput
  sequenceScope: NonNullable<JobExpect['sequenceScope']>
}
export function storeReviewedInput(
  input: PreparedInput,
  scope?: JobExpect['sequenceScope'],
): string {
  const stored: PreparedInput | StoredReviewedInput = scope
    ? { kind: 'plein-reviewed-sequence-input', version: 1, input, sequenceScope: scope }
    : input
  return JSON.stringify(stored)
}
function readReviewedInput(raw: string): {
  input: PreparedInput
  sequenceScope?: JobExpect['sequenceScope']
} {
  const value = JSON.parse(raw) as PreparedInput | StoredReviewedInput
  if ('kind' in value && value.kind === 'plein-reviewed-sequence-input') {
    if (
      value.version !== 1 ||
      !value.input ||
      !value.sequenceScope ||
      !Array.isArray(value.sequenceScope.shotIds) ||
      !Array.isArray(value.sequenceScope.clipInstanceIds)
    )
      throw new Error('保存的序列审核范围损坏，请重新检查')
    return { input: value.input, sequenceScope: value.sequenceScope }
  }
  return { input: value as PreparedInput }
}

/** 只冻结会改变输入的文档事实，排除布局、运行进度、审核及交付意见。 */
export function batchSourceKey(doc: PleinDoc, el: CanvasElement): string {
  return createHash('sha256')
    .update(
      stableStringify({
        name: el.name,
        kind: el.kind,
        nodeType: el.nodeType,
        version: el.nodeVersion,
        params: el.params,
        assetId: el.assetId,
        text: el.text,
        ports: el.ports,
        edges: [...doc.edges()]
          .filter((edge) => edge.to[0] === el.id)
          .map(({ id, from, to, order }) => ({ id, from, to, order }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }),
    )
    .digest('hex')
}

export function parseExpect(raw: string | null | undefined): JobExpect | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as JobExpect
  } catch {
    return undefined
  }
}

/** 批次快照需要的运行能力（NodeRuns 提供） */
export interface BatchHost {
  readonly store: JobStore
  inspect(
    doc: PleinDoc,
    el: CanvasElement,
    ownerId: string,
    signal: AbortSignal,
  ): Promise<Inspection>
  resultMatches(el: CanvasElement, inspection: Inspection): boolean
  planKey(el: CanvasElement): string
}

/**
 * 批次启动时定下每个目标：执行阶段、批准的实际输入、待解析的依赖与原因。
 * 沿用的前提是自己的结果有效且本批次里没有要重新生成的上游；上游要重新生成的，
 * 输入要等上游出结果才知道，先记依赖和上游当时的结果，提交前再冻结
 */
export async function snapshotBatch(
  host: BatchHost,
  g: { id: string; canvas_id: string; owner_id: string },
  source: PleinDoc,
  targets: string[],
  graph: FlowGraph,
  opts: {
    force?: boolean
    rerun: Set<string>
    /** 用户确认保留的过期结果也算沿用 */
    kept?: (el: CanvasElement, inspection: Inspection) => Promise<boolean>
  },
  signal: AbortSignal,
) {
  // 调用方持有 live Doc；只在本次副本里复用检查结果，避免 await 期间的编辑混入快照。
  const snapshot = new Y.Doc()
  let doc: PleinDoc | undefined
  try {
    Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(source.ydoc))
    doc = createDoc(snapshot, { schedule: () => {} })
    const inBatch = new Set(targets)
    const inspections = new Map<string, Inspection>()
    const fresh = new Map<string, boolean>()
    for (const id of inBatch) {
      const el = doc.get(id)
      if (!el) continue
      const inspection = await host.inspect(doc, el, g.owner_id, signal)
      inspections.set(id, inspection)
      const reusable = !opts.force && !opts.rerun.has(id)
      fresh.set(
        id,
        reusable && (host.resultMatches(el, inspection) || !!(await opts.kept?.(el, inspection))),
      )
    }
    const now = Date.now()
    const rows: BatchItemRow[] = []
    for (const [seq, id] of targets.entries()) {
      const el = doc.get(id)
      if (!el) continue
      const ups = [...graph.ancestors(id)].filter((u) => inBatch.has(u))
      const rerunUps = ups.filter((u) => !fresh.get(u))
      const deps: BatchDependency[] = []
      for (const u of rerunUps) {
        const upstream = doc.get(u)
        const r = upstream && currentResult(upstream)
        deps.push(r ? { nodeId: u, resultId: r.id } : { nodeId: u })
      }
      const { input } = inspections.get(id)!
      let stage: BatchStage = 'run'
      let reason: string | undefined
      if (fresh.get(id) && !rerunUps.length) {
        stage = 'reuse'
        reason = '参数和输入都没变，沿用当前结果'
      } else if (!deps.length && input.status !== 'ready') {
        stage = 'blocked'
        reason = input.blocked.map((b) => b.message).join('；')
      } else if (deps.length) reason = '等上游生成后再定实际输入'
      rows.push({
        group_id: g.id,
        node_id: id,
        seq,
        stage,
        reason: reason ?? null,
        input_hash: !deps.length && input.inputHash ? input.inputHash : null,
        plan_hash: host.planKey(el),
        deps: JSON.stringify(deps),
        input: JSON.stringify(input),
        frozen_hash: null,
        job_id: null,
        outcome: 'pending',
        result_id: null,
        updated_at: now,
      })
    }
    host.store.insertBatchItems(rows)
  } finally {
    doc?.destroy()
    snapshot.destroy()
  }
}

/** 批次里一个目标提交时带的计划 */
export function expectOf(item: BatchItemRow): JobExpect {
  const deps = JSON.parse(item.deps) as BatchDependency[]
  const reviewed = item.input ? readReviewedInput(item.input) : undefined
  const scope = reviewed?.sequenceScope ? { sequenceScope: reviewed.sequenceScope } : {}
  if (item.input_hash)
    return { inputHash: item.input_hash, ...(deps.length ? { deps } : {}), ...scope }
  return { ...(item.plan_hash ? { planHash: item.plan_hash } : {}), deps, ...scope }
}

/**
 * 计划有没有变：变了返回原因（给人看），没变返回 undefined。
 * deps 里每个上游现在的结果要么还是启动时那个，要么是本批次产生的
 */
export function planChange(
  expect: JobExpect,
  now: { inputHash?: string; planHash: string },
  ctx: { doc: PleinDoc; groupId?: string | null; store: JobStore },
): string | undefined {
  if (expect.inputHash !== undefined && now.inputHash !== expect.inputHash)
    return '实际输入与确认时不同'
  if (expect.planHash && expect.planHash !== now.planHash) return '节点的参数或模型与确认时不同'
  for (const dep of expect.deps ?? []) {
    const up = ctx.doc.get(dep.nodeId)
    if (dep.sourceKey && (!up || batchSourceKey(ctx.doc, up) !== dep.sourceKey))
      return `「${up?.name ?? dep.nodeId}」的内容或连线与清单不同`
    const r = up && currentResult(up)
    if (!r || r.id === dep.resultId) continue
    if (ctx.groupId) {
      if (ctx.store.batchItem(ctx.groupId, dep.nodeId)?.result_id === r.id) continue
      if (ctx.store.get(r.runId)?.group_id === ctx.groupId) continue
    }
    return `上游「${up.name ?? dep.nodeId}」的结果换成了本批次以外的`
  }
  return undefined
}

/** 任务结束后对应的批次结局 */
export function outcomeOf(job: JobRow | undefined): BatchOutcome {
  if (!job) return 'failed'
  if (job.status === 'succeeded') return 'succeeded'
  if (job.status === 'canceled') return 'canceled'
  if (job.status === 'failed' && parseRecovery(job.recovery).state === 'review') return 'review'
  return job.status === 'failed' ? 'failed' : 'running'
}

export function batchItem(row: BatchItemRow): BatchItem {
  return {
    nodeId: row.node_id,
    seq: row.seq,
    stage: row.stage as BatchStage,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.input_hash ? { inputHash: row.input_hash } : {}),
    deps: JSON.parse(row.deps) as BatchDependency[],
    ...(row.input ? { input: readReviewedInput(row.input).input } : {}),
    ...(row.frozen_hash ? { frozenHash: row.frozen_hash } : {}),
    ...(row.job_id ? { jobId: row.job_id } : {}),
    outcome: row.outcome as BatchOutcome,
    ...(row.result_id ? { resultId: row.result_id } : {}),
    updatedAt: row.updated_at,
  }
}

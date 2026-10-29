import type {
  GroupRunOptions,
  GroupRunSummary,
  JobStatus,
  PreparedInput,
  SubmissionAudit,
} from '@plein/protocol'
import { randomUUID } from 'node:crypto'
import {
  addCredentialUsage,
  type CallJournal,
  type CallRecord,
  type CredentialUsage,
} from '../plugins/host'
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { DB } from '../storage/db'
import { batchItems, impactDecisions, jobGroups, jobs } from '../storage/schema'
import { parseRecovery } from './recovery'

export type { JobStatus }

export type JobRow = typeof jobs.$inferSelect
export type GroupRow = typeof jobGroups.$inferSelect
export type DecisionRow = typeof impactDecisions.$inferSelect
export type BatchItemRow = typeof batchItems.$inferSelect

type JobPatch = Partial<
  Pick<
    JobRow,
    | 'status'
    | 'attempts'
    | 'cache_key'
    | 'cache_omit'
    | 'input'
    | 'expect'
    | 'frozen'
    | 'recovery'
    | 'error'
    | 'started_at'
    | 'finished_at'
  >
>

/** 任务与整组运行的持久化 */
export class JobStore {
  private listeners = new Set<(id: string) => void>()
  constructor(private db: DB) {}

  onChange(fn: (id: string) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(id: string) {
    for (const fn of this.listeners) fn(id)
  }

  insert(job: {
    id: string
    ownerId: string
    canvasId: string
    nodeId: string
    groupId?: string
    nodeType: string
    /** 批准的计划（JobExpect JSON） */
    expect?: string
  }) {
    this.db
      .insert(jobs)
      .values({
        id: job.id,
        owner_id: job.ownerId,
        canvas_id: job.canvasId,
        node_id: job.nodeId,
        group_id: job.groupId ?? null,
        node_type: job.nodeType,
        expect: job.expect ?? null,
        status: 'queued',
        created_at: Date.now(),
      })
      .run()
  }

  get(id: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get()
  }

  countForNode(canvasId: string, nodeId: string): number {
    return (
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(jobs)
        .where(and(eq(jobs.canvas_id, canvasId), eq(jobs.node_id, nodeId)))
        .get()?.count ?? 0
    )
  }

  unsettledForType(canvasId: string, nodeType: string): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.canvas_id, canvasId),
          eq(jobs.node_type, nodeType),
          inArray(jobs.status, ['queued', 'running', 'failed', 'canceled']),
        ),
      )
      .all()
  }

  update(id: string, patch: JobPatch) {
    if (Object.keys(patch).length === 0) return
    // 显式传 undefined 的字段写成 NULL（与改用 Drizzle 前一致）
    const set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null]))
    this.db.update(jobs).set(set).where(eq(jobs.id, id)).run()
    if ('status' in patch || 'recovery' in patch) this.changed(id)
  }

  /** 服务重启时还没结束的任务，按创建顺序 */
  active(): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running']))
      .orderBy(asc(jobs.created_at))
      .all()
  }

  /** 某次整组运行里这个节点已经成功的任务（重启后继续整组时不重复跑） */
  succeededInGroup(groupId: string, nodeId: string): JobRow | undefined {
    return this.db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.group_id, groupId), eq(jobs.node_id, nodeId), eq(jobs.status, 'succeeded')),
      )
      .limit(1)
      .get()
  }

  /** 一批任务，按 id 取（影响分析对照节点各个候选是哪次运行产生的） */
  many(ids: string[]): JobRow[] {
    if (!ids.length) return []
    return this.db.select().from(jobs).where(inArray(jobs.id, ids)).all()
  }

  /** 模型调用记录：读写这个任务的 calls 列 */
  journal(id: string): CallJournal {
    const read = (): Record<string, CallRecord> => JSON.parse(this.get(id)?.calls ?? '{}')
    const write = (calls: Record<string, CallRecord>, audit?: SubmissionAudit) => {
      this.db
        .update(jobs)
        .set({
          calls: JSON.stringify(calls),
          ...(audit
            ? {
                call_history: JSON.stringify([
                  ...JSON.parse(this.get(id)?.call_history ?? '[]'),
                  audit,
                ]),
              }
            : {}),
        })
        .where(eq(jobs.id, id))
        .run()
      this.changed(id)
    }
    return {
      id,
      get: (key) => read()[key],
      set: (key, record, audit) => write({ ...read(), [key]: record }, audit),
      delete: (key) => {
        const calls = read()
        delete calls[key]
        write(calls)
      },
    }
  }

  /**
   * 设置页低频查询：SQL 先排除空调用，再按平台汇总还没完成结果入库的密钥组调用；
   * dismissed 不再提示、排除在外，canceled 的平台任务可能仍在生成，保留计入。
   */
  credentialUsage(): CredentialUsage {
    const usage: CredentialUsage = {}
    const rows = this.db
      .select({ calls: jobs.calls, input: jobs.input, recovery: jobs.recovery })
      .from(jobs)
      .where(ne(jobs.calls, '{}'))
      .all()
    for (const row of rows) {
      if (parseRecovery(row.recovery).dismissed) continue
      const calls = JSON.parse(row.calls) as Record<string, CallRecord>
      let input: PreparedInput | undefined
      for (const record of Object.values(calls)) {
        if (!record.provider && !input && row.input) input = JSON.parse(row.input) as PreparedInput
        const provider = record.provider ?? input?.model?.provider
        if (provider) addCredentialUsage(usage, provider, record)
      }
    }
    return usage
  }

  /** 人工决策、旧未知证据和活动调用/排队状态一次落盘；失败时全部回滚。 */
  manualRecovery(
    id: string,
    action: 'resubmit' | 'attach' | 'dismiss',
    keys: string[],
    patch: JobPatch,
    remoteId?: string,
  ) {
    this.db.transaction((tx) => {
      const row = tx.select().from(jobs).where(eq(jobs.id, id)).get()
      if (!row) throw new Error('任务不存在')
      const calls = JSON.parse(row.calls) as Record<string, CallRecord>
      const history = JSON.parse(row.call_history) as Array<
        SubmissionAudit & { previousError?: string; previousMessage?: string }
      >
      for (const key of keys.length ? keys : ['']) {
        const old = calls[key]
        history.push({
          id: randomUUID(),
          at: Date.now(),
          callKey: key,
          kind: `manual_${action}`,
          ...old?.trace,
          ...(old ? { previousState: old.state } : {}),
          ...(old && 'at' in old ? { previousAt: old.at } : {}),
          ...(old?.state === 'unknown' ? { previousMessage: old.message } : {}),
          ...(row.error ? { previousError: row.error } : {}),
          ...(remoteId ? { remoteId } : {}),
        })
        if (action === 'resubmit') delete calls[key]
        if (action === 'attach' && key === keys[0])
          calls[key] = {
            state: 'pending',
            remoteId: remoteId!,
            ...(old?.trace ? { trace: old.trace } : {}),
            ...(old?.provider ? { provider: old.provider } : {}),
            ...(old?.credentialId ? { credentialId: old.credentialId } : {}),
            ...(old?.credentialFingerprint
              ? { credentialFingerprint: old.credentialFingerprint }
              : {}),
            ...(old?.credentialLabel ? { credentialLabel: old.credentialLabel } : {}),
          }
      }
      tx.update(jobs)
        .set({ ...patch, calls: JSON.stringify(calls), call_history: JSON.stringify(history) })
        .where(eq(jobs.id, id))
        .run()
    })
    this.changed(id)
  }

  /** 画布最近的任务，新的在前 */
  recent(canvasId: string, limit: number): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.canvas_id, canvasId))
      .orderBy(desc(jobs.created_at), sql`rowid DESC`)
      .limit(limit)
      .all()
  }

  /** 使用 jobs_node 索引，每个节点最多读一行；同毫秒用插入顺序区分。 */
  latestForNodes(canvasId: string, nodeIds: readonly string[]): JobRow[] {
    if (nodeIds.length > 100) throw new RangeError('每次最多查询 100 个节点')
    return [...new Set(nodeIds)].flatMap((nodeId) => {
      const row = this.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.canvas_id, canvasId), eq(jobs.node_id, nodeId)))
        .orderBy(desc(jobs.created_at), sql`rowid DESC`)
        .limit(1)
        .get()
      return row ? [row] : []
    })
  }

  recentGroups(canvasId: string, limit: number): GroupRow[] {
    return this.db
      .select()
      .from(jobGroups)
      .where(eq(jobGroups.canvas_id, canvasId))
      .orderBy(desc(jobGroups.created_at), sql`rowid DESC`)
      .limit(limit)
      .all()
  }

  insertGroup(g: {
    id: string
    ownerId: string
    canvasId: string
    frameId: string
    options: GroupRunOptions & { scope?: string; rerun?: string[] }
    targets: string[]
  }) {
    this.db
      .insert(jobGroups)
      .values({
        id: g.id,
        owner_id: g.ownerId,
        canvas_id: g.canvasId,
        frame_id: g.frameId,
        options: JSON.stringify(g.options),
        targets: JSON.stringify(g.targets),
        status: 'running',
        created_at: Date.now(),
      })
      .run()
  }

  group(id: string): GroupRow | undefined {
    return this.db.select().from(jobGroups).where(eq(jobGroups.id, id)).get()
  }

  finishGroup(id: string, status: 'done' | 'canceled', summary: GroupRunSummary) {
    this.db
      .update(jobGroups)
      .set({ status, summary: JSON.stringify(summary), finished_at: Date.now() })
      .where(eq(jobGroups.id, id))
      .run()
  }

  activeGroups(): GroupRow[] {
    return this.db
      .select()
      .from(jobGroups)
      .where(eq(jobGroups.status, 'running'))
      .orderBy(asc(jobGroups.created_at))
      .all()
  }

  /** 节点在某个时间之后创建的任务（判断晚返回的结果是不是已被更新的运行取代） */
  newerJobs(canvasId: string, nodeId: string, after: number): JobRow[] {
    return this.db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.canvas_id, canvasId), eq(jobs.node_id, nodeId), sql`created_at > ${after}`),
      )
      .all()
  }

  // ── 批次快照 ──

  insertBatchItems(rows: BatchItemRow[]) {
    if (!rows.length) return
    this.db.insert(batchItems).values(rows).run()
  }

  /** 清单确认与批准输入同一事务落库，进程重启也不会丢失批准边界。 */
  insertApprovedGroup(group: Parameters<JobStore['insertGroup']>[0], items: BatchItemRow[]) {
    this.db.transaction(() => {
      this.insertGroup(group)
      this.insertBatchItems(items)
    })
  }

  batchItems(groupId: string): BatchItemRow[] {
    return this.db
      .select()
      .from(batchItems)
      .where(eq(batchItems.group_id, groupId))
      .orderBy(asc(batchItems.seq))
      .all()
  }

  batchItem(groupId: string, nodeId: string): BatchItemRow | undefined {
    return this.db
      .select()
      .from(batchItems)
      .where(and(eq(batchItems.group_id, groupId), eq(batchItems.node_id, nodeId)))
      .get()
  }

  updateBatchItem(
    groupId: string,
    nodeId: string,
    patch: Partial<
      Pick<BatchItemRow, 'frozen_hash' | 'job_id' | 'outcome' | 'result_id' | 'reason'>
    >,
  ) {
    this.db
      .update(batchItems)
      .set({ ...patch, updated_at: Date.now() })
      .where(and(eq(batchItems.group_id, groupId), eq(batchItems.node_id, nodeId)))
      .run()
  }

  /** 每组等重新审查的目标数 */
  reviewCounts(groupIds: string[]): Map<string, number> {
    if (!groupIds.length) return new Map()
    const rows = this.db
      .select({ group: batchItems.group_id, n: sql<number>`count(*)` })
      .from(batchItems)
      .where(and(inArray(batchItems.group_id, groupIds), eq(batchItems.outcome, 'review')))
      .groupBy(batchItems.group_id)
      .all()
    return new Map(rows.map((r) => [r.group, r.n]))
  }

  // ── 保留决定 ──

  insertDecision(d: Omit<DecisionRow, 'revoked_at'>) {
    this.db.insert(impactDecisions).values(d).run()
  }

  /** 画布的保留决定，新的在前 */
  decisions(canvasId: string, limit = 200): DecisionRow[] {
    return this.db
      .select()
      .from(impactDecisions)
      .where(eq(impactDecisions.canvas_id, canvasId))
      .orderBy(desc(impactDecisions.created_at), sql`rowid DESC`)
      .limit(limit)
      .all()
  }

  /** 撤销：记录留着，只记下撤销时间；没找到或已撤销时返回 false */
  revokeDecision(canvasId: string, id: string): boolean {
    const r = this.db
      .update(impactDecisions)
      .set({ revoked_at: Date.now() })
      .where(
        and(
          eq(impactDecisions.id, id),
          eq(impactDecisions.canvas_id, canvasId),
          sql`revoked_at IS NULL`,
        ),
      )
      .run()
    return r.changes > 0
  }
}

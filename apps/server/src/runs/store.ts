import type { GroupRunOptions, GroupRunSummary, JobStatus } from '@plein/protocol'
import type { CallJournal, CallRecord } from '../plugins/host'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DB } from '../storage/db'
import { jobGroups, jobs } from '../storage/schema'

export type { JobStatus }

export type JobRow = typeof jobs.$inferSelect
export type GroupRow = typeof jobGroups.$inferSelect

type JobPatch = Partial<
  Pick<
    JobRow,
    | 'status'
    | 'attempts'
    | 'cache_key'
    | 'cache_omit'
    | 'input'
    | 'error'
    | 'started_at'
    | 'finished_at'
  >
>

/** 任务与整组运行的持久化 */
export class JobStore {
  constructor(private db: DB) {}

  insert(job: {
    id: string
    ownerId: string
    canvasId: string
    nodeId: string
    groupId?: string
    nodeType: string
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
        status: 'queued',
        created_at: Date.now(),
      })
      .run()
  }

  get(id: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get()
  }

  update(id: string, patch: JobPatch) {
    if (Object.keys(patch).length === 0) return
    // 显式传 undefined 的字段写成 NULL（与改用 Drizzle 前一致）
    const set = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null]))
    this.db.update(jobs).set(set).where(eq(jobs.id, id)).run()
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

  /** 模型调用记录：读写这个任务的 calls 列 */
  journal(id: string): CallJournal {
    const read = (): Record<string, CallRecord> => JSON.parse(this.get(id)?.calls ?? '{}')
    const write = (calls: Record<string, CallRecord>) =>
      this.db
        .update(jobs)
        .set({ calls: JSON.stringify(calls) })
        .where(eq(jobs.id, id))
        .run()
    return {
      get: (key) => read()[key],
      set: (key, record) => write({ ...read(), [key]: record }),
      delete: (key) => {
        const calls = read()
        delete calls[key]
        write(calls)
      },
    }
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
}

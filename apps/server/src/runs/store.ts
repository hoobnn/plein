import type { GroupRunOptions, GroupRunSummary } from '@plein/protocol'
import type { CallJournal, CallRecord } from '../plugins/host'
import type { DB } from '../storage/db'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface JobRow {
  id: string
  owner_id: string
  canvas_id: string
  node_id: string
  group_id: string | null
  node_type: string
  status: JobStatus
  attempts: number
  cache_key: string | null
  cache_omit: string | null
  calls: string
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export interface GroupRow {
  id: string
  owner_id: string
  canvas_id: string
  frame_id: string
  options: string
  targets: string
  status: 'running' | 'done' | 'canceled'
  summary: string | null
  created_at: number
  finished_at: number | null
}

type JobPatch = Partial<
  Pick<
    JobRow,
    'status' | 'attempts' | 'cache_key' | 'cache_omit' | 'error' | 'started_at' | 'finished_at'
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
      .prepare(
        `INSERT INTO jobs (id, owner_id, canvas_id, node_id, group_id, node_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(
        job.id,
        job.ownerId,
        job.canvasId,
        job.nodeId,
        job.groupId ?? null,
        job.nodeType,
        Date.now(),
      )
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare<[string], JobRow>('SELECT * FROM jobs WHERE id = ?').get(id)
  }

  update(id: string, patch: JobPatch) {
    const keys = Object.keys(patch) as (keyof JobPatch)[]
    if (keys.length === 0) return
    this.db
      .prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => patch[k] ?? null), id)
  }

  /** 服务重启时还没结束的任务，按创建顺序 */
  active(): JobRow[] {
    return this.db
      .prepare<[], JobRow>(
        "SELECT * FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at",
      )
      .all()
  }

  /** 某次整组运行里这个节点已经成功的任务（重启后继续整组时不重复跑） */
  succeededInGroup(groupId: string, nodeId: string): JobRow | undefined {
    return this.db
      .prepare<[string, string], JobRow>(
        "SELECT * FROM jobs WHERE group_id = ? AND node_id = ? AND status = 'succeeded' LIMIT 1",
      )
      .get(groupId, nodeId)
  }

  /** 模型调用记录：读写这个任务的 calls 列 */
  journal(id: string): CallJournal {
    const read = (): Record<string, CallRecord> => JSON.parse(this.get(id)?.calls ?? '{}')
    const write = (calls: Record<string, CallRecord>) =>
      this.db.prepare('UPDATE jobs SET calls = ? WHERE id = ?').run(JSON.stringify(calls), id)
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
      .prepare<[string, number], JobRow>(
        'SELECT * FROM jobs WHERE canvas_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(canvasId, limit)
  }

  recentGroups(canvasId: string, limit: number): GroupRow[] {
    return this.db
      .prepare<[string, number], GroupRow>(
        'SELECT * FROM job_groups WHERE canvas_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
      )
      .all(canvasId, limit)
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
      .prepare(
        `INSERT INTO job_groups (id, owner_id, canvas_id, frame_id, options, targets, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        g.id,
        g.ownerId,
        g.canvasId,
        g.frameId,
        JSON.stringify(g.options),
        JSON.stringify(g.targets),
        Date.now(),
      )
  }

  group(id: string): GroupRow | undefined {
    return this.db.prepare<[string], GroupRow>('SELECT * FROM job_groups WHERE id = ?').get(id)
  }

  finishGroup(id: string, status: 'done' | 'canceled', summary: GroupRunSummary) {
    this.db
      .prepare('UPDATE job_groups SET status = ?, summary = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(summary), Date.now(), id)
  }

  activeGroups(): GroupRow[] {
    return this.db
      .prepare<[], GroupRow>(
        "SELECT * FROM job_groups WHERE status = 'running' ORDER BY created_at",
      )
      .all()
  }
}

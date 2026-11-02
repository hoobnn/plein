import type { DB } from '../storage/db'
import type { CheckpointRow } from './archive'

/**
 * 检查点的存储模块：SQL 收在这里，服务层只拿结构化数据。
 * 见 CONTRIBUTING.md「结构调整约定 › 数据访问」。
 *
 * 表结构由迁移脚本定义（canvas_checkpoints / checkpoint_assets），
 * 这里用原生 SQL 与既有写法保持一致。
 */

/** 检查点所属画布 */
export interface CheckpointCanvasRow {
  project_id: string
  title: string
}

/** 恢复检查点时重建的运行记录 */
export interface CheckpointJobRow {
  node_id: string
  node_type: string
  status: string
  attempts: number
  cache_key: string | null
  cache_omit: string | null
  input: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

export class CheckpointStore {
  constructor(private db: DB) {}

  /** 一条检查点 */
  row(owner: string, checkpointId: string): CheckpointRow | undefined {
    return this.db.$client
      .prepare('SELECT * FROM canvas_checkpoints WHERE id=? AND owner_id=?')
      .get(checkpointId, owner) as CheckpointRow | undefined
  }

  /** 检查点所属的画布 */
  canvas(owner: string, canvasId: string): CheckpointCanvasRow | undefined {
    return this.db.$client
      .prepare('SELECT project_id,title FROM canvases WHERE id=? AND owner_id=?')
      .get(canvasId, owner) as CheckpointCanvasRow | undefined
  }

  /** 项目是否存在 */
  projectExists(owner: string, projectId: string): boolean {
    return !!this.db.$client
      .prepare('SELECT id FROM projects WHERE id=? AND owner_id=?')
      .get(projectId, owner)
  }

  /** 一条运行记录 */
  job(owner: string, canvasId: string, jobId: string): CheckpointJobRow | undefined {
    return this.db.$client
      .prepare('SELECT * FROM jobs WHERE id=? AND owner_id=? AND canvas_id=?')
      .get(jobId, owner, canvasId) as CheckpointJobRow | undefined
  }

  /** 资产库条目是否存在 */
  libraryItemExists(owner: string, libraryId: string): boolean {
    return !!this.db.$client
      .prepare('SELECT id FROM library_items WHERE id=? AND owner_id=?')
      .get(libraryId, owner)
  }

  /** 按条件分页列出检查点；条件与参数由调用方拼好 */
  list(conditions: string[], args: unknown[], limit: number): CheckpointRow[] {
    return this.db.$client
      .prepare(
        `SELECT * FROM canvas_checkpoints WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(...args, limit) as CheckpointRow[]
  }

  /** 写入一条检查点与它引用的素材；回调在同一事务内执行 */
  insert(row: CheckpointRow, assetIds: string[], within?: () => void): void {
    this.db.$client.transaction(() => {
      this.db.$client
        .prepare(
          'INSERT INTO canvas_checkpoints(id,owner_id,project_id,source_canvas_id,source_canvas_title,name,state,history,created_at,content_hash) VALUES(@id,@owner_id,@project_id,@source_canvas_id,@source_canvas_title,@name,@state,@history,@created_at,@content_hash)',
        )
        .run(row)
      const pin = this.db.$client.prepare(
        'INSERT INTO checkpoint_assets(checkpoint_id,owner_id,asset_id) VALUES(?,?,?)',
      )
      for (const asset of assetIds) pin.run(row.id, row.owner_id, asset)
      within?.()
    })()
  }

  /** 删掉一条检查点；回调在同一事务内执行 */
  remove(owner: string, checkpointId: string, within?: () => void): void {
    this.db.$client.transaction(() => {
      this.db.$client
        .prepare('DELETE FROM canvas_checkpoints WHERE id=? AND owner_id=?')
        .run(checkpointId, owner)
      within?.()
    })()
  }

  /**
   * 恢复检查点：重建画布、文档增量与运行记录，并更新项目时间。
   * 全部在同一个事务里，失败时不留下半张画布。
   */
  restore(input: CheckpointRestoreInput): void {
    const { canvas, doc, jobs, projectId, owner, now, within } = input
    this.db.$client.transaction(() => {
      this.db.$client
        .prepare(
          'INSERT INTO canvases(id,owner_id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        )
        .run(canvas.id, owner, projectId, canvas.title, now, now)
      this.db.$client
        .prepare('INSERT INTO doc_updates(canvas_id,data,created_at) VALUES(?,?,?)')
        .run(canvas.id, doc.state, now)
      const put = this.db.$client.prepare(
        "INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,attempts,cache_key,cache_omit,input,error,created_at,started_at,finished_at,calls) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}')",
      )
      for (const job of jobs) {
        put.run(
          job.id,
          owner,
          canvas.id,
          job.nodeId,
          job.nodeType,
          job.status,
          job.attempts,
          job.cacheKey,
          job.cacheOmit,
          job.input === undefined ? null : JSON.stringify(job.input),
          null,
          job.createdAt,
          job.startedAt,
          job.finishedAt ?? now,
        )
      }
      this.db.$client
        .prepare('UPDATE projects SET updated_at=? WHERE id=? AND owner_id=?')
        .run(now, projectId, owner)
      within?.()
    })()
  }
}

/** 恢复检查点时要写进数据库的记录 */
export interface CheckpointRestoreInput {
  owner: string
  projectId: string
  now: number
  canvas: { id: string; title: string }
  doc: { state: Buffer }
  jobs: {
    id: string
    nodeId: string
    nodeType: string
    status: string
    attempts: number
    cacheKey: string | null
    cacheOmit: string | null
    input: unknown
    createdAt: number
    startedAt: number | null
    finishedAt: number | null
  }[]
  /** 同一事务内执行的回调（重建派生索引） */
  within?: () => void
}

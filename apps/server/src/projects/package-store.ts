import { and, asc, eq, inArray } from 'drizzle-orm'
import type { JobStatus } from '@plein/protocol'
import type { Conn, DB } from '../storage/db'
import { canvases, docUpdates, jobs, libraryItems, projects } from '../storage/schema'

/**
 * 项目包的数据访问：导出要读什么、导入要写什么，都收在这里。
 * 业务层只拿结构化数据，不直接 import Drizzle。
 * 见 CONTRIBUTING.md「结构调整约定 › 数据访问」。
 *
 * 事务边界不变：项目、画布、文档、资产库条目、运行记录与检查点
 * 仍然在同一个事务里写入，失败时不留下半个项目。
 */

/** 项目包导入要写入的项目行 */
export interface PackageProjectRow {
  id: string
  owner_id: string
  title: string
  created_at: number
  updated_at: number
}

/** 项目包导入要写入的画布行 */
export interface PackageCanvasRow {
  id: string
  owner_id: string
  project_id: string
  title: string
  created_at: number
  updated_at: number
}

/** 项目包导入要写入的资产库条目行 */
export interface PackageLibraryRow {
  id: string
  owner_id: string
  project_id: string | null
  kind: string
  name: string
  data: string
  favorite: number
  created_at: number
  updated_at: number
}

/** 项目包导入要写入的运行记录行 */
export interface PackageJobRow {
  id: string
  owner_id: string
  canvas_id: string
  node_id: string
  node_type: string
  status: JobStatus
  attempts: number
  cache_key: string | null
  cache_omit: string | null
  input: string | null
  error: string | null
  created_at: number
  started_at: number | null
  finished_at: number
}

/** 项目包导入要写入的文档增量 */
export interface PackageDocUpdateRow {
  canvas_id: string
  data: Buffer
  created_at: number
}

/** 检查点主记录：原生 SQL 写入，字段与迁移脚本一致 */
export interface PackageCheckpointRow {
  id: string
  owner_id: string
  project_id: string
  source_canvas_id: string | null
  source_canvas_title: string
  name: string
  state: Buffer
  history: string
  created_at: number
  content_hash: string
}

export class PackageStore {
  constructor(private db: DB) {}

  // ── 导出：读 ──────────────────────────────────────

  /** 画布文档增量，按 id 顺序重放 */
  docUpdates(canvasId: string) {
    return this.db
      .select({ data: docUpdates.data })
      .from(docUpdates)
      .where(eq(docUpdates.canvas_id, canvasId))
      .orderBy(asc(docUpdates.id))
      .all()
  }

  /** 项目本身 */
  project(owner: string, projectId: string) {
    return this.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.owner_id, owner)))
      .get()
  }

  /** 项目下的画布 */
  projectCanvases(owner: string, projectId: string) {
    return this.db
      .select()
      .from(canvases)
      .where(and(eq(canvases.project_id, projectId), eq(canvases.owner_id, owner)))
      .orderBy(asc(canvases.created_at))
      .all()
  }

  /** 归属这个项目的资产库条目 */
  ownedLibraryItems(owner: string, projectId: string) {
    return this.db
      .select()
      .from(libraryItems)
      .where(and(eq(libraryItems.owner_id, owner), eq(libraryItems.project_id, projectId)))
      .all()
  }

  /** 画布上引用到的资产库条目（可能是不归属任何项目的全局条目） */
  referencedLibraryItems(owner: string, ids: string[]) {
    return this.db
      .select()
      .from(libraryItems)
      .where(and(eq(libraryItems.owner_id, owner), inArray(libraryItems.id, ids)))
      .all()
  }

  /** 这些画布上的运行记录 */
  canvasJobs(owner: string, canvasIds: string[]) {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.owner_id, owner), inArray(jobs.canvas_id, canvasIds)))
      .orderBy(asc(jobs.created_at))
      .all()
  }

  // ── 导入：冲突检测 ────────────────────────────────

  /** 同名项目是否已存在 */
  projectExists(id: string): boolean {
    return Boolean(
      this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).get(),
    )
  }

  /** 已存在的画布 id */
  existingCanvasIds(ids: string[]): Set<string> {
    if (!ids.length) return new Set()
    return new Set(
      this.db
        .select({ id: canvases.id })
        .from(canvases)
        .where(inArray(canvases.id, ids))
        .all()
        .map((r) => r.id),
    )
  }

  /** 资产库条目的 id 与所有者：判断是本机已有可复用的，还是别的项目的 */
  libraryOwners(ids: string[]) {
    if (!ids.length) return []
    return this.db
      .select({ id: libraryItems.id, owner: libraryItems.owner_id })
      .from(libraryItems)
      .where(inArray(libraryItems.id, ids))
      .all()
  }

  /** 已存在的运行记录 id；分批查，避免超长 IN */
  existingJobIds(ids: string[]): Set<string> {
    const hit = new Set<string>()
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const r of this.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.id, chunk))
        .all())
        hit.add(r.id)
    }
    return hit
  }

  /** 检查点 id 是否已被占用 */
  checkpointExists(id: string): boolean {
    const row = this.db.$client.prepare('SELECT id FROM canvas_checkpoints WHERE id=?').get(id)
    return !!row
  }

  // ── 导入：写 ──────────────────────────────────────

  insertProject(conn: Conn, row: PackageProjectRow): void {
    conn.insert(projects).values(row).run()
  }

  insertCanvas(conn: Conn, row: PackageCanvasRow): void {
    conn.insert(canvases).values(row).run()
  }

  insertDocUpdate(conn: Conn, row: PackageDocUpdateRow): void {
    conn.insert(docUpdates).values(row).run()
  }

  insertLibraryItem(conn: Conn, row: PackageLibraryRow): void {
    conn.insert(libraryItems).values(row).run()
  }

  insertJob(conn: Conn, row: PackageJobRow): void {
    conn.insert(jobs).values(row).run()
  }

  /** 检查点主记录：原生 SQL，字段与迁移脚本一致 */
  insertCheckpoint(row: PackageCheckpointRow): void {
    this.db.$client
      .prepare(
        'INSERT INTO canvas_checkpoints(id,owner_id,project_id,source_canvas_id,source_canvas_title,name,state,history,created_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        row.owner_id,
        row.project_id,
        row.source_canvas_id,
        row.source_canvas_title,
        row.name,
        row.state,
        row.history,
        row.created_at,
        row.content_hash,
      )
  }

  /** 检查点引用的素材 */
  insertCheckpointAssets(checkpointId: string, ownerId: string, assetIds: string[]): void {
    const pin = this.db.$client.prepare(
      'INSERT INTO checkpoint_assets(checkpoint_id,owner_id,asset_id) VALUES(?,?,?)',
    )
    for (const asset of assetIds) pin.run(checkpointId, ownerId, asset)
  }
}

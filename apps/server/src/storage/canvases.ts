import { randomBytes } from 'node:crypto'
import type { Canvas, Project } from '@plein/protocol'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Conn, DB } from './db'
import { canvases, projects } from './schema'

/** 画布列表和详情用到的列；迁移前的老画布 project_id 已补齐，按非空处理 */
export const canvasColumns = {
  id: canvases.id,
  project_id: sql<string>`${canvases.project_id}`,
  title: canvases.title,
  created_at: canvases.created_at,
  updated_at: canvases.updated_at,
}

export type CanvasRow = {
  id: string
  project_id: string
  title: string
  created_at: number
  updated_at: number
}

export const toCanvas = (r: CanvasRow): Canvas => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function newCanvasId() {
  return `cv_${randomBytes(9).toString('base64url')}`
}

export function newProjectId() {
  return `pj_${randomBytes(9).toString('base64url')}`
}

/** 项目所有权检查 */
export function ownsProject(db: DB, ownerId: string, id: string) {
  return Boolean(
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.owner_id, ownerId)))
      .get(),
  )
}

/** 在项目下建一张画布，项目的修改时间跟着更新 */
export function insertCanvas(db: Conn, owner: string, projectId: string, title: string) {
  const now = Date.now()
  const id = newCanvasId()
  db.transaction((tx) => {
    tx.insert(canvases)
      .values({
        id,
        owner_id: owner,
        project_id: projectId,
        title,
        created_at: now,
        updated_at: now,
      })
      .run()
    tx.update(projects).set({ updated_at: now }).where(eq(projects.id, projectId)).run()
  })
  return id
}

/** 新建项目，可选同时建第一张画布 */
export function insertProject(db: Conn, owner: string, title: string) {
  const now = Date.now()
  const id = newProjectId()
  db.insert(projects).values({ id, owner_id: owner, title, created_at: now, updated_at: now }).run()
  return id
}

/** 画布所有权检查，HTTP 与 WS 同步共用 */
export function ownsCanvas(db: DB, ownerId: string, id: string) {
  return Boolean(
    db
      .select({ id: canvases.id })
      .from(canvases)
      .where(and(eq(canvases.id, id), eq(canvases.owner_id, ownerId)))
      .get(),
  )
}

/** 一张画布；不属于该所有者时没有 */
export function getCanvas(db: DB, owner: string, id: string) {
  return db
    .select(canvasColumns)
    .from(canvases)
    .where(and(eq(canvases.id, id), eq(canvases.owner_id, owner)))
    .get()
}

/** 改画布标题；改到了返回 true */
export function updateCanvasTitle(db: DB, owner: string, id: string, title: string) {
  const res = db
    .update(canvases)
    .set({ title, updated_at: Date.now() })
    .where(and(eq(canvases.id, id), eq(canvases.owner_id, owner)))
    .run()
  return res.changes > 0
}

/** 删画布；删掉了返回 true */
export function deleteCanvas(db: DB, owner: string, id: string) {
  const res = db
    .delete(canvases)
    .where(and(eq(canvases.id, id), eq(canvases.owner_id, owner)))
    .run()
  return res.changes > 0
}

export function listCanvases(db: DB, owner: string, projectId?: string) {
  return db
    .select(canvasColumns)
    .from(canvases)
    .where(
      and(
        eq(canvases.owner_id, owner),
        projectId === undefined ? undefined : eq(canvases.project_id, projectId),
      ),
    )
    .orderBy(desc(canvases.updated_at), sql`rowid DESC`)
    .all()
    .map(toCanvas)
}

/** 项目列表和详情用到的列：修改时间取项目与其下画布里最新的那个 */
const projectColumns = {
  id: projects.id,
  title: projects.title,
  created_at: projects.created_at,
  updated_at: sql<number>`MAX(${projects.updated_at}, COALESCE(MAX(${canvases.updated_at}), 0))`.as(
    'updated_at',
  ),
  canvases: sql<number>`COUNT(${canvases.id})`.as('canvases'),
  last_canvas: sql<string | null>`(
    SELECT lc.id FROM canvases lc WHERE lc.project_id = ${projects.id}
    ORDER BY lc.updated_at DESC, lc.rowid DESC LIMIT 1
  )`.as('last_canvas'),
}

type ProjectRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
  canvases: number
  last_canvas: string | null
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  canvases: r.canvases,
  lastCanvasId: r.last_canvas,
})

/** 某人的项目列表：画布数与最后修改的画布一起查出来 */
export function listProjects(db: DB, owner: string): Project[] {
  const rows = db
    .select(projectColumns)
    .from(projects)
    .leftJoin(canvases, eq(canvases.project_id, projects.id))
    .where(eq(projects.owner_id, owner))
    .groupBy(projects.id)
    .orderBy(sql`updated_at DESC`, sql`${projects}.rowid DESC`)
    .all()
  return rows.map(toProject)
}

/** 一个项目；不属于该所有者时没有 */
export function getProject(db: DB, owner: string, id: string): Project | undefined {
  const row = db
    .select(projectColumns)
    .from(projects)
    .leftJoin(canvases, eq(canvases.project_id, projects.id))
    .where(and(eq(projects.id, id), eq(projects.owner_id, owner)))
    .groupBy(projects.id)
    .get()
  return row ? toProject(row) : undefined
}

/** 新建项目，同时建第一张画布 */
export function insertProjectWithCanvas(db: DB, owner: string, title: string) {
  return db.transaction((tx) => {
    const pid = insertProject(tx, owner, title)
    insertCanvas(tx, owner, pid, '画布 1')
    return pid
  })
}

/** 改项目标题；改到了返回 true */
export function updateProjectTitle(db: DB, owner: string, id: string, title: string) {
  const res = db
    .update(projects)
    .set({ title, updated_at: Date.now() })
    .where(and(eq(projects.id, id), eq(projects.owner_id, owner)))
    .run()
  return res.changes > 0
}

/** 删项目，其下画布随外键级联删除；删掉了返回 true */
export function deleteProject(db: DB, owner: string, id: string) {
  const res = db
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.owner_id, owner)))
    .run()
  return res.changes > 0
}

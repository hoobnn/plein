import { randomBytes } from 'node:crypto'
import type { Canvas } from '@plein/protocol'
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

function newCanvasId() {
  return `cv_${randomBytes(9).toString('base64url')}`
}

function newProjectId() {
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

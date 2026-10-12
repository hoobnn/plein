import { randomBytes } from 'node:crypto'
import type { Canvas } from '@plein/protocol'
import type { DB } from './db'

export interface CanvasRow {
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
    db.prepare('SELECT 1 FROM projects WHERE id = ? AND owner_id = ?').get(id, ownerId),
  )
}

/** 在项目下建一张画布，项目的修改时间跟着更新 */
export function insertCanvas(db: DB, owner: string, projectId: string, title: string) {
  const now = Date.now()
  const id = newCanvasId()
  db.transaction(() => {
    db.prepare(
      'INSERT INTO canvases (id, owner_id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, owner, projectId, title, now, now)
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId)
  })()
  return id
}

/** 新建项目，可选同时建第一张画布 */
export function insertProject(db: DB, owner: string, title: string) {
  const now = Date.now()
  const id = newProjectId()
  db.prepare(
    'INSERT INTO projects (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, owner, title, now, now)
  return id
}

export const CANVAS_COLUMNS = 'id, project_id, title, created_at, updated_at'

/** 画布所有权检查，HTTP 与 WS 同步共用 */
export function ownsCanvas(db: DB, ownerId: string, id: string) {
  return Boolean(
    db.prepare('SELECT 1 FROM canvases WHERE id = ? AND owner_id = ?').get(id, ownerId),
  )
}

export function listCanvases(db: DB, owner: string, projectId?: string) {
  return projectId
    ? db
        .prepare<[string, string], CanvasRow>(
          `SELECT ${CANVAS_COLUMNS} FROM canvases WHERE owner_id = ? AND project_id = ? ORDER BY updated_at DESC, rowid DESC`,
        )
        .all(owner, projectId)
        .map(toCanvas)
    : db
        .prepare<[string], CanvasRow>(
          `SELECT ${CANVAS_COLUMNS} FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC, rowid DESC`,
        )
        .all(owner)
        .map(toCanvas)
}

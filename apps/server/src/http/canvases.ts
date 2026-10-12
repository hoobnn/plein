import { randomBytes } from 'node:crypto'
import { createDoc, currentResult } from '@plein/doc'
import { API, type Canvas, CreateCanvas, UpdateCanvas } from '@plein/protocol'
import { Hono } from 'hono'
import * as Y from 'yjs'
import type { AuthEnv } from '../auth'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'

interface CanvasRow {
  id: string
  project_id: string
  title: string
  created_at: number
  updated_at: number
}

const toCanvas = (r: CanvasRow): Canvas => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const MAX_COVERS = 4

interface Preview {
  updatedAt: number
  covers: string[]
  elements: number
}

/**
 * 首页缩略图：重放文档取最近生成的图片 / 视频（节点结果按时间新到旧，其后是导入的素材），
 * 只用已生成的衍生图（缩略图、视频封面），没有就跳过。按 updated_at 缓存。
 */
export type Previewer = ReturnType<typeof previewer>

export function previewer(db: DB) {
  const cache = new Map<string, Preview>()
  const updates = db.prepare<[string], { data: Buffer }>(
    'SELECT data FROM doc_updates WHERE canvas_id = ? ORDER BY id',
  )
  const variants = db.prepare<[string, string], { variants: string }>(
    'SELECT variants FROM assets WHERE owner_id = ? AND id = ?',
  )

  const compute = (owner: string, id: string): Omit<Preview, 'updatedAt'> => {
    const ydoc = new Y.Doc()
    for (const r of updates.all(id)) Y.applyUpdate(ydoc, new Uint8Array(r.data))
    const doc = createDoc(ydoc, { schedule: () => {} })
    try {
      const generated: Array<{ assetId: string; at: number }> = []
      const imported: string[] = []
      let elements = 0
      for (const el of doc.elements()) {
        elements++
        if (el.kind === 'node') {
          const r = currentResult(el)
          if (r && (r.value.type === 'image' || r.value.type === 'video'))
            generated.push({ assetId: r.value.assetId, at: r.at })
        } else if ((el.kind === 'image' || el.kind === 'video') && el.assetId) {
          imported.push(el.assetId)
        }
      }
      generated.sort((a, b) => b.at - a.at)
      const covers: string[] = []
      for (const assetId of new Set([...generated.map((g) => g.assetId), ...imported])) {
        const row = variants.get(owner, assetId)
        const list: string[] = row ? JSON.parse(row.variants) : []
        const v = list.includes('thumb-1024')
          ? 'thumb-1024'
          : list.includes('poster')
            ? 'poster'
            : null
        if (v) covers.push(API.assetVariant(assetId, v))
        if (covers.length === MAX_COVERS) break
      }
      return { covers, elements }
    } finally {
      doc.destroy()
      ydoc.destroy()
    }
  }

  return (owner: string, c: Canvas): Canvas => {
    let p = cache.get(c.id)
    if (!p || p.updatedAt !== c.updatedAt) {
      try {
        p = { updatedAt: c.updatedAt, ...compute(owner, c.id) }
      } catch {
        // 文档损坏或版本更高时不出缩略图，列表照常返回
        p = { updatedAt: c.updatedAt, covers: [], elements: 0 }
      }
      cache.set(c.id, p)
    }
    return { ...c, covers: p.covers, elements: p.elements }
  }
}

export function newCanvasId() {
  return `cv_${randomBytes(9).toString('base64url')}`
}

export function newProjectId() {
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

export function canvasRoutes(db: DB, rooms: Rooms, preview: Previewer) {
  const get = (owner: string, id: string) =>
    db
      .prepare<[string, string], CanvasRow>(
        `SELECT ${CANVAS_COLUMNS} FROM canvases WHERE id = ? AND owner_id = ?`,
      )
      .get(id, owner)
  const notFound = { error: 'not_found', message: '画布不存在' }

  return new Hono<AuthEnv>()
    .get(API.canvases, (c) => {
      const owner = c.var.principal.id
      const projectId = c.req.query('projectId') || undefined
      return c.json(listCanvases(db, owner, projectId).map((cv) => preview(owner, cv)))
    })
    .post(API.canvases, async (c) => {
      const body = CreateCanvas.safeParse((await c.req.json().catch(() => ({}))) ?? {})
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      let projectId = body.data.projectId
      if (projectId && !ownsProject(db, owner, projectId))
        return c.json({ error: 'not_found', message: '项目不存在' }, 404)
      // 没指定项目：旧客户端和脚本照常能建，顺手建一个同名项目
      projectId ??= insertProject(db, owner, body.data.title)
      const id = insertCanvas(db, owner, projectId, body.data.title)
      return c.json(toCanvas(get(owner, id)!), 201)
    })
    .get('/api/canvases/:id', (c) => {
      const row = get(c.var.principal.id, c.req.param('id'))
      return row ? c.json(toCanvas(row)) : c.json(notFound, 404)
    })
    .patch('/api/canvases/:id', async (c) => {
      const body = UpdateCanvas.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const id = c.req.param('id')
      const res = db
        .prepare('UPDATE canvases SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
        .run(body.data.title, Date.now(), id, c.var.principal.id)
      return res.changes ? c.json(toCanvas(get(c.var.principal.id, id)!)) : c.json(notFound, 404)
    })
    .delete('/api/canvases/:id', (c) => {
      const id = c.req.param('id')
      const res = db
        .prepare('DELETE FROM canvases WHERE id = ? AND owner_id = ?')
        .run(id, c.var.principal.id)
      if (!res.changes) return c.json(notFound, 404)
      rooms.drop(id)
      return c.body(null, 204)
    })
}

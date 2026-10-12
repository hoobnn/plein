import { randomBytes } from 'node:crypto'
import { API, type Canvas, CreateCanvas, UpdateCanvas } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'

interface CanvasRow {
  id: string
  title: string
  created_at: number
  updated_at: number
}

const toCanvas = (r: CanvasRow): Canvas => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export function newCanvasId() {
  return `cv_${randomBytes(9).toString('base64url')}`
}

/** 画布所有权检查，HTTP 与 WS 同步共用 */
export function ownsCanvas(db: DB, ownerId: string, id: string) {
  return Boolean(
    db.prepare('SELECT 1 FROM canvases WHERE id = ? AND owner_id = ?').get(id, ownerId),
  )
}

export function canvasRoutes(db: DB, rooms: Rooms) {
  const get = (owner: string, id: string) =>
    db
      .prepare<[string, string], CanvasRow>(
        'SELECT id, title, created_at, updated_at FROM canvases WHERE id = ? AND owner_id = ?',
      )
      .get(id, owner)
  const notFound = { error: 'not_found', message: '画布不存在' }

  return new Hono<AuthEnv>()
    .get(API.canvases, (c) => {
      const rows = db
        .prepare<[string], CanvasRow>(
          'SELECT id, title, created_at, updated_at FROM canvases WHERE owner_id = ? ORDER BY updated_at DESC',
        )
        .all(c.var.principal.id)
      return c.json(rows.map(toCanvas))
    })
    .post(API.canvases, async (c) => {
      const body = CreateCanvas.safeParse((await c.req.json().catch(() => ({}))) ?? {})
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const now = Date.now()
      const id = newCanvasId()
      db.prepare(
        'INSERT INTO canvases (id, owner_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, c.var.principal.id, body.data.title, now, now)
      return c.json(toCanvas(get(c.var.principal.id, id)!), 201)
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

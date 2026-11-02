import { API, CreateCanvas, UpdateCanvas } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import {
  deleteCanvas,
  getCanvas,
  insertCanvas,
  insertProject,
  listCanvases,
  ownsProject,
  toCanvas,
  updateCanvasTitle,
} from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Previewer } from '../storage/previews'
import type { Rooms } from '../sync/rooms'

export function canvasRoutes(db: DB, rooms: Rooms, preview: Previewer) {
  const get = (owner: string, id: string) => getCanvas(db, owner, id)
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
      const owner = c.var.principal.id
      const changed = updateCanvasTitle(db, owner, id, body.data.title)
      return changed ? c.json(toCanvas(get(owner, id)!)) : c.json(notFound, 404)
    })
    .delete('/api/canvases/:id', (c) => {
      const id = c.req.param('id')
      const deleted = deleteCanvas(db, c.var.principal.id, id)
      if (!deleted) return c.json(notFound, 404)
      rooms.drop(id)
      return c.body(null, 204)
    })
}

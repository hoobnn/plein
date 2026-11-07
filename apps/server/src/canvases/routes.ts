import { API, CreateCanvas, DuplicateCanvas, UpdateCanvas } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { MediaIndex } from '../media-index/service'
import { CanvasOpError, duplicateCanvas, moveCanvasTo } from './duplicate'
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

export function canvasRoutes(db: DB, rooms: Rooms, preview: Previewer, mediaIndex?: MediaIndex) {
  const ops = { db, rooms, mediaIndex }
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
      if (!get(owner, id)) return c.json(notFound, 404)
      try {
        // 先移动（会校验目标项目），再改标题，免得移动失败时标题已经改了
        if (body.data.projectId) moveCanvasTo(ops, owner, id, body.data.projectId)
        if (body.data.title) updateCanvasTitle(db, owner, id, body.data.title)
      } catch (err) {
        if (err instanceof CanvasOpError)
          return c.json({ error: 'not_found', message: err.message }, err.status)
        throw err
      }
      return c.json(toCanvas(get(owner, id)!))
    })
    .post('/api/canvases/:id/duplicate', async (c) => {
      const body = DuplicateCanvas.safeParse((await c.req.json().catch(() => ({}))) ?? {})
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        return c.json(duplicateCanvas(ops, c.var.principal.id, c.req.param('id'), body.data), 201)
      } catch (err) {
        if (err instanceof CanvasOpError)
          return c.json({ error: 'not_found', message: err.message }, err.status)
        throw err
      }
    })
    .delete('/api/canvases/:id', (c) => {
      const id = c.req.param('id')
      const deleted = deleteCanvas(db, c.var.principal.id, id)
      if (!deleted) return c.json(notFound, 404)
      rooms.drop(id)
      return c.body(null, 204)
    })
}

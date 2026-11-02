import { API, CreateProject, UpdateProject } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import {
  deleteProject,
  getProject,
  insertProjectWithCanvas,
  listCanvases,
  listProjects,
  updateProjectTitle,
} from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Previewer } from '../storage/previews'
import type { Rooms } from '../sync/rooms'

const MAX_COVERS = 4

/** 项目：列表、新建（同时建第一张画布）、改名、删除（其下画布一并删除，资产库条目保留） */
export function projectRoutes(db: DB, rooms: Rooms, preview: Previewer) {
  const notFound = { error: 'not_found', message: '项目不存在' }

  /** 封面：按画布从新到旧，取各画布的缩略图凑满 4 张 */
  const covers = (owner: string, id: string) => {
    const out: string[] = []
    for (const cv of listCanvases(db, owner, id)) {
      for (const src of preview(owner, cv).covers ?? []) {
        if (!out.includes(src)) out.push(src)
        if (out.length === MAX_COVERS) return out
      }
    }
    return out
  }

  return new Hono<AuthEnv>()
    .get(API.projects, (c) => {
      const owner = c.var.principal.id
      const rows = listProjects(db, owner)
      return c.json(rows.map((r) => ({ ...r, covers: covers(owner, r.id) })))
    })
    .post(API.projects, async (c) => {
      const body = CreateProject.safeParse((await c.req.json().catch(() => ({}))) ?? {})
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const id = insertProjectWithCanvas(db, owner, body.data.title)
      return c.json(getProject(db, owner, id)!, 201)
    })
    .get('/api/projects/:id', (c) => {
      const owner = c.var.principal.id
      const row = getProject(db, owner, c.req.param('id'))
      return row ? c.json(row) : c.json(notFound, 404)
    })
    .get('/api/projects/:id/canvases', (c) => {
      const owner = c.var.principal.id
      const id = c.req.param('id')
      if (!getProject(db, owner, id)) return c.json(notFound, 404)
      return c.json(listCanvases(db, owner, id))
    })
    .patch('/api/projects/:id', async (c) => {
      const body = UpdateProject.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const id = c.req.param('id')
      const changed = updateProjectTitle(db, owner, id, body.data.title)
      return changed ? c.json(getProject(db, owner, id)!) : c.json(notFound, 404)
    })
    .delete('/api/projects/:id', (c) => {
      const owner = c.var.principal.id
      const id = c.req.param('id')
      const ids = listCanvases(db, owner, id).map((cv) => cv.id)
      const deleted = deleteProject(db, owner, id)
      if (!deleted) return c.json(notFound, 404)
      for (const cv of ids) rooms.drop(cv)
      return c.body(null, 204)
    })
}

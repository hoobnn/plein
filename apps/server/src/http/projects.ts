import { API, CreateProject, type Project, UpdateProject } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { insertCanvas, insertProject, listCanvases } from '../storage/canvases'
import type { Previewer } from '../storage/previews'

interface ProjectRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  canvases: number
  last_canvas: string | null
}

const MAX_COVERS = 4

/** 项目的修改时间取项目本身和其下画布里最新的那个 */
const SELECT = `
  SELECT p.id, p.title, p.created_at,
    MAX(p.updated_at, COALESCE(MAX(c.updated_at), 0)) AS updated_at,
    COUNT(c.id) AS canvases,
    (SELECT id FROM canvases WHERE project_id = p.id ORDER BY updated_at DESC, rowid DESC LIMIT 1) AS last_canvas
  FROM projects p LEFT JOIN canvases c ON c.project_id = p.id
`

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  canvases: r.canvases,
  lastCanvasId: r.last_canvas,
})

/** 项目：列表、新建（同时建第一张画布）、改名、删除（其下画布一并删除，资产库条目保留） */
export function projectRoutes(db: DB, rooms: Rooms, preview: Previewer) {
  const get = (owner: string, id: string) =>
    db
      .prepare<[string, string], ProjectRow>(
        `${SELECT} WHERE p.id = ? AND p.owner_id = ? GROUP BY p.id`,
      )
      .get(id, owner)
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
      const rows = db
        .prepare<[string], ProjectRow>(
          `${SELECT} WHERE p.owner_id = ? GROUP BY p.id ORDER BY updated_at DESC, p.rowid DESC`,
        )
        .all(owner)
      return c.json(rows.map((r) => ({ ...toProject(r), covers: covers(owner, r.id) })))
    })
    .post(API.projects, async (c) => {
      const body = CreateProject.safeParse((await c.req.json().catch(() => ({}))) ?? {})
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const id = db.transaction(() => {
        const pid = insertProject(db, owner, body.data.title)
        insertCanvas(db, owner, pid, '画布 1')
        return pid
      })()
      return c.json(toProject(get(owner, id)!), 201)
    })
    .get('/api/projects/:id', (c) => {
      const row = get(c.var.principal.id, c.req.param('id'))
      return row ? c.json(toProject(row)) : c.json(notFound, 404)
    })
    .get('/api/projects/:id/canvases', (c) => {
      const owner = c.var.principal.id
      const id = c.req.param('id')
      if (!get(owner, id)) return c.json(notFound, 404)
      return c.json(listCanvases(db, owner, id))
    })
    .patch('/api/projects/:id', async (c) => {
      const body = UpdateProject.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const id = c.req.param('id')
      const res = db
        .prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
        .run(body.data.title, Date.now(), id, owner)
      return res.changes ? c.json(toProject(get(owner, id)!)) : c.json(notFound, 404)
    })
    .delete('/api/projects/:id', (c) => {
      const owner = c.var.principal.id
      const id = c.req.param('id')
      const canvases = listCanvases(db, owner, id).map((cv) => cv.id)
      const res = db.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(id, owner)
      if (!res.changes) return c.json(notFound, 404)
      for (const cv of canvases) rooms.drop(cv)
      return c.body(null, 204)
    })
}

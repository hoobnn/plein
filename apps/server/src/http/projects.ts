import { API, CreateProject, type Project, UpdateProject } from '@plein/protocol'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { DB } from '../storage/db'
import { canvases, projects } from '../storage/schema'
import type { Rooms } from '../sync/rooms'
import { insertCanvas, insertProject, listCanvases } from '../storage/canvases'
import type { Previewer } from '../storage/previews'

const MAX_COVERS = 4

/** 项目的修改时间取项目本身和其下画布里最新的那个 */
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

/** 项目：列表、新建（同时建第一张画布）、改名、删除（其下画布一并删除，资产库条目保留） */
export function projectRoutes(db: DB, rooms: Rooms, preview: Previewer) {
  const select = () =>
    db
      .select(projectColumns)
      .from(projects)
      .leftJoin(canvases, eq(canvases.project_id, projects.id))
  const get = (owner: string, id: string): ProjectRow | undefined =>
    select()
      .where(and(eq(projects.id, id), eq(projects.owner_id, owner)))
      .groupBy(projects.id)
      .get()
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
      const rows = select()
        .where(eq(projects.owner_id, owner))
        .groupBy(projects.id)
        .orderBy(sql`updated_at DESC`, sql`${projects}.rowid DESC`)
        .all()
      return c.json(rows.map((r) => ({ ...toProject(r), covers: covers(owner, r.id) })))
    })
    .post(API.projects, async (c) => {
      const body = CreateProject.safeParse((await c.req.json().catch(() => ({}))) ?? {})
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const id = db.transaction((tx) => {
        const pid = insertProject(tx, owner, body.data.title)
        insertCanvas(tx, owner, pid, '画布 1')
        return pid
      })
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
        .update(projects)
        .set({ title: body.data.title, updated_at: Date.now() })
        .where(and(eq(projects.id, id), eq(projects.owner_id, owner)))
        .run()
      return res.changes ? c.json(toProject(get(owner, id)!)) : c.json(notFound, 404)
    })
    .delete('/api/projects/:id', (c) => {
      const owner = c.var.principal.id
      const id = c.req.param('id')
      const ids = listCanvases(db, owner, id).map((cv) => cv.id)
      const res = db
        .delete(projects)
        .where(and(eq(projects.id, id), eq(projects.owner_id, owner)))
        .run()
      if (!res.changes) return c.json(notFound, 404)
      for (const cv of ids) rooms.drop(cv)
      return c.body(null, 204)
    })
}

import { randomBytes } from 'node:crypto'
import {
  API,
  CreateLibraryItem,
  type LibraryItem,
  LibraryKind,
  UpdateLibraryItem,
} from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { DB } from '../storage/db'
import { ownsProject } from './canvases'

interface LibraryRow {
  id: string
  project_id: string | null
  kind: LibraryItem['kind']
  name: string
  data: string
  favorite: number
  used_at: number | null
  created_at: number
  updated_at: number
}

/** data 列里存的字段 */
type LibraryData = Pick<
  LibraryItem,
  'description' | 'tags' | 'voice' | 'images' | 'video' | 'models'
>

const toItem = (r: LibraryRow): LibraryItem => {
  const d = JSON.parse(r.data) as Partial<LibraryData>
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    projectId: r.project_id,
    description: d.description ?? '',
    tags: d.tags ?? {},
    voice: d.voice ?? null,
    images: d.images ?? [],
    video: d.video ?? null,
    models: d.models ?? [],
    favorite: r.favorite === 1,
    usedAt: r.used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const dataOf = (i: LibraryData): string =>
  JSON.stringify({
    description: i.description,
    tags: i.tags,
    voice: i.voice,
    images: i.images,
    video: i.video,
    models: i.models,
  })

/** 资产库：角色 / 场景 / 道具 / 风格 / 特效条目的增删改查，按所有者隔离 */
export function libraryRoutes(db: DB) {
  const notFound = { error: 'not_found', message: '资产不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能修改资产库' }
  const noProject = { error: 'not_found', message: '项目不存在' }
  const get = (owner: string, id: string) =>
    db
      .prepare<[string, string], LibraryRow>(
        'SELECT * FROM library_items WHERE id = ? AND owner_id = ?',
      )
      .get(id, owner)

  return new Hono<AuthEnv>()
    .get(API.library, (c) => {
      const owner = c.var.principal.id
      const kind = LibraryKind.safeParse(c.req.query('kind'))
      const rows = kind.success
        ? db
            .prepare<[string, string], LibraryRow>(
              'SELECT * FROM library_items WHERE owner_id = ? AND kind = ? ORDER BY updated_at DESC',
            )
            .all(owner, kind.data)
        : db
            .prepare<[string], LibraryRow>(
              'SELECT * FROM library_items WHERE owner_id = ? ORDER BY updated_at DESC',
            )
            .all(owner)
      return c.json(rows.map(toItem))
    })
    .post(API.library, async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const body = CreateLibraryItem.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const { kind, name, projectId, ...data } = body.data
      if (projectId && !ownsProject(db, owner, projectId)) return c.json(noProject, 404)
      const id = `lib_${randomBytes(9).toString('base64url')}`
      const now = Date.now()
      db.prepare(
        `INSERT INTO library_items (id, owner_id, project_id, kind, name, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, owner, projectId, kind, name, dataOf(data), now, now)
      return c.json(toItem(get(owner, id)!), 201)
    })
    .get('/api/library/:id', (c) => {
      const row = get(c.var.principal.id, c.req.param('id'))
      return row ? c.json(toItem(row)) : c.json(notFound, 404)
    })
    .patch('/api/library/:id', async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const body = UpdateLibraryItem.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const row = get(owner, c.req.param('id'))
      if (!row) return c.json(notFound, 404)
      const { name, projectId, favorite, ...patch } = body.data
      if (projectId && !ownsProject(db, owner, projectId)) return c.json(noProject, 404)
      const cur = toItem(row)
      // 只是收藏 / 取消收藏不算修改，列表顺序不跳
      const edited = Object.keys(body.data).some((k) => k !== 'favorite')
      db.prepare(
        `UPDATE library_items SET name = ?, project_id = ?, data = ?, favorite = ?, updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      ).run(
        name ?? cur.name,
        projectId === undefined ? cur.projectId : projectId,
        dataOf({ ...cur, ...patch }),
        (favorite ?? cur.favorite) ? 1 : 0,
        edited ? Date.now() : cur.updatedAt,
        row.id,
        owner,
      )
      return c.json(toItem(get(owner, row.id)!))
    })
    .post('/api/library/:id/use', (c) => {
      const owner = c.var.principal.id
      const res = db
        .prepare('UPDATE library_items SET used_at = ? WHERE id = ? AND owner_id = ?')
        .run(Date.now(), c.req.param('id'), owner)
      return res.changes ? c.body(null, 204) : c.json(notFound, 404)
    })
    .delete('/api/library/:id', (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const res = db
        .prepare('DELETE FROM library_items WHERE id = ? AND owner_id = ?')
        .run(c.req.param('id'), c.var.principal.id)
      return res.changes ? c.body(null, 204) : c.json(notFound, 404)
    })
}

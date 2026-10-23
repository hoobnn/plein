import { API, CreateLibraryItem, LibraryKind, UpdateLibraryItem } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { LibrarySourceError, type LibraryStore } from '../library/store'
import type { DB } from '../storage/db'
import { ownsProject } from '../storage/canvases'

/** 资产库：角色 / 场景 / 道具 / 风格 / 特效条目的增删改查，按所有者隔离 */
export function libraryRoutes(db: DB, library: LibraryStore) {
  const notFound = { error: 'not_found', message: '资产不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能修改资产库' }
  const noProject = { error: 'not_found', message: '项目不存在' }

  return new Hono<AuthEnv>()
    .get(API.library, (c) => {
      const kind = LibraryKind.safeParse(c.req.query('kind'))
      return c.json(library.list(c.var.principal.id, kind.success ? kind.data : undefined))
    })
    .post(API.library, async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const body = CreateLibraryItem.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      const { projectId } = body.data
      if (projectId && !ownsProject(db, owner, projectId)) return c.json(noProject, 404)
      try {
        return c.json(library.create(owner, body.data), 201)
      } catch (error) {
        if (error instanceof LibrarySourceError)
          return c.json({ error: 'invalid_source', message: error.message }, 422)
        throw error
      }
    })
    .get('/api/library/:id', (c) => {
      const item = library.get(c.var.principal.id, c.req.param('id'))
      return item ? c.json(item) : c.json(notFound, 404)
    })
    .patch('/api/library/:id', async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const body = UpdateLibraryItem.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const owner = c.var.principal.id
      if (!library.get(owner, c.req.param('id'))) return c.json(notFound, 404)
      const { projectId } = body.data
      if (projectId && !ownsProject(db, owner, projectId)) return c.json(noProject, 404)
      try {
        return c.json(library.update(owner, c.req.param('id'), body.data)!)
      } catch (error) {
        if (error instanceof LibrarySourceError)
          return c.json({ error: 'invalid_source', message: error.message }, 422)
        throw error
      }
    })
    .post('/api/library/:id/use', (c) =>
      library.markUsed(c.var.principal.id, c.req.param('id'))
        ? c.body(null, 204)
        : c.json(notFound, 404),
    )
    .delete('/api/library/:id', (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      return library.remove(c.var.principal.id, c.req.param('id'))
        ? c.body(null, 204)
        : c.json(notFound, 404)
    })
}

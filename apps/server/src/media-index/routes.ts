import { MediaLibraryQuery } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { MediaIndexError, type MediaIndex } from './service'

export function mediaLibraryRoutes(index: MediaIndex) {
  const app = new Hono<AuthEnv>()
  app.onError((error, c) => {
    if (error instanceof MediaIndexError)
      return c.json(
        { error: error.code, message: error.message },
        error.code === 'not_found' ? 404 : error.code === 'media_index_building' ? 503 : 400,
      )
    throw error
  })
  app.get('/api/assets', (c) => {
    const query = MediaLibraryQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid', message: query.error.message }, 400)
    return c.json(index.list(c.var.principal.id, query.data))
  })
  app.get('/api/assets/:id/sources', (c) => {
    const query = MediaLibraryQuery.pick({ cursor: true, limit: true }).safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid', message: query.error.message }, 400)
    return c.json(index.sources(c.var.principal.id, c.req.param('id'), query.data))
  })
  return app
}

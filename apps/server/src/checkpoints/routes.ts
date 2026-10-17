import { CheckpointQuery, CreateCheckpoint, RestoreCheckpoint } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { CheckpointError, type CheckpointService } from './service'

export function checkpointRoutes(service: CheckpointService) {
  const app = new Hono<AuthEnv>()
  app.onError((error, c) => {
    if (error instanceof CheckpointError)
      return c.json(
        { error: error.code, message: error.message },
        error.code === 'not_found'
          ? 404
          : error.code === 'sync_pending'
            ? 409
            : error.code === 'unsupported_version'
              ? 422
              : 400,
      )
    throw error
  })
  app.post('/api/canvases/:id/checkpoints', async (c) => {
    if (c.var.principal.role === 'viewer')
      return c.json({ error: 'forbidden', message: '只读成员不能保存检查点' }, 403)
    const body = CreateCheckpoint.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
    return c.json(service.create(c.var.principal.id, c.req.param('id'), body.data), 201)
  })
  app.get('/api/projects/:id/checkpoints', (c) => {
    const query = CheckpointQuery.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid', message: query.error.message }, 400)
    return c.json(service.list(c.var.principal.id, c.req.param('id'), query.data))
  })
  app.get('/api/checkpoints/:id', (c) =>
    c.json(service.detail(c.var.principal.id, c.req.param('id'))),
  )
  app.delete('/api/checkpoints/:id', (c) => {
    if (c.var.principal.role === 'viewer')
      return c.json({ error: 'forbidden', message: '只读成员不能删除检查点' }, 403)
    service.remove(c.var.principal.id, c.req.param('id'))
    return c.body(null, 204)
  })
  app.post('/api/checkpoints/:id/restore', async (c) => {
    if (c.var.principal.role === 'viewer')
      return c.json({ error: 'forbidden', message: '只读成员不能恢复检查点' }, 403)
    const body = RestoreCheckpoint.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
    return c.json(service.restore(c.var.principal.id, c.req.param('id'), body.data.title), 201)
  })
  return app
}

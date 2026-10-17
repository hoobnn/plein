import { MaintenanceSettings, MaintenanceToken } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { MaintenanceError, type MaintenanceService } from './service'

/** 维护可以看到整库和本机路径，登录模式下不开放；须放在常规鉴权和跨站防护之后。 */
export function maintenanceRoutes(service: MaintenanceService | null) {
  const app = new Hono<AuthEnv>()
  app.use('/api/maintenance/*', async (c, next) => {
    if (!service) return c.json({ error: 'disabled', message: '本地数据维护只在本机模式可用' }, 403)
    if (c.var.principal.role !== 'owner')
      return c.json({ error: 'forbidden', message: '只有所有者可以维护本机数据' }, 403)
    await next()
  })
  if (!service) return app
  app.onError((error, c) => {
    if (error instanceof MaintenanceError)
      return c.json(
        { error: error.code, message: error.message },
        error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 409,
      )
    // 本机维护需要可操作的失败原因；不返回堆栈或文件内容。
    return c.json({ error: 'maintenance_failed', message: (error as Error).message }, 500)
  })
  app.get('/api/maintenance/status', async (c) => c.json(await service.status()))
  app.get('/api/maintenance/space', async (c) => c.json(await service.space()))
  app.put('/api/maintenance/settings', async (c) => {
    const body = MaintenanceSettings.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
    return c.json(await service.settings(body.data))
  })
  app.post('/api/maintenance/backups', async (c) => c.json(await service.backup(), 201))
  app.post('/api/maintenance/backups/:id/restore-copy', async (c) =>
    c.json(await service.restoreCopy(c.req.param('id')), 201),
  )
  app.post('/api/maintenance/cleanup/preview', async (c) => c.json(await service.preview()))
  app.post('/api/maintenance/cleanup', async (c) => {
    const body = MaintenanceToken.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
    return c.json(await service.cleanup(body.data.token))
  })
  app.post('/api/maintenance/trash/:id/restore', async (c) =>
    c.json(await service.restoreTrash(c.req.param('id'))),
  )
  return app
}

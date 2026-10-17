import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, request } from '../testing'
import { maintenanceRoutes } from './routes'

describe('维护接口与关闭生命周期', () => {
  it('空数据库也能生成并恢复完整备份；关闭等待正在进行的备份后再关闭SQLite', async () => {
    const f = await bootServer()
    const pending = f.server.maintenance!.backup()
    const closing = f.close()
    const backup = await pending
    await closing
    expect(existsSync(backup.path)).toBe(true)
    expect(f.server.db.$client.open).toBe(false)
  })

  it('空库备份/恢复副本的HTTP入口可用，非法设置和过期token有明确错误', async () => {
    const f = await bootServer()
    const response = await request(f.server, '/api/maintenance/backups', { method: 'POST' })
    expect(response.status).toBe(201)
    const backup = (await response.json()) as { id: string }
    const restored = await request(f.server, `/api/maintenance/backups/${backup.id}/restore-copy`, {
      method: 'POST',
    })
    expect(restored.status).toBe(201)
    expect(((await restored.json()) as { restartRequired: boolean }).restartRequired).toBe(true)
    expect(
      (
        await request(f.server, '/api/maintenance/settings', {
          method: 'PUT',
          body: '{"intervalHours":0}',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await request(f.server, '/api/maintenance/cleanup', {
          method: 'POST',
          body: '{"token":"00000000-0000-4000-8000-000000000000"}',
        })
      ).status,
    ).toBe(409)
  })

  it('登录部署与非owner不暴露整库备份、空间和本机路径', async () => {
    const f = await bootServer({ config: { auth: 'password' } })
    expect(f.server.maintenance).toBeNull()
    const app = new Hono<AuthEnv>()
    app.use('*', async (c, next) => {
      c.set('principal', { id: 'viewer', role: 'viewer' })
      await next()
    })
    app.route('/', maintenanceRoutes(null))
    expect((await app.request('/api/maintenance/status')).status).toBe(403)
    const local = await bootServer()
    const viewer = new Hono<AuthEnv>()
    viewer.use('*', async (c, next) => {
      c.set('principal', { id: 'viewer', role: 'viewer' })
      await next()
    })
    viewer.route('/', maintenanceRoutes(local.server.maintenance))
    expect((await viewer.request('/api/maintenance/status')).status).toBe(403)
    expect((await viewer.request('/api/maintenance/backups', { method: 'POST' })).status).toBe(403)
  })
})

import type { ExternalMcpStatus, ExternalMcpToken } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { ExternalMcp } from './external'

/** 对外开放 MCP 的设置接口：只在本机免登录模式（含桌面端）开放 */
export function mcpRoutes(external: ExternalMcp | null) {
  const off = { error: 'disabled', message: '对外开放 MCP 只在本机模式可用' }
  const app = new Hono<AuthEnv>()
  app.use('/api/mcp/*', async (c, next) => {
    if (!external) return c.json(off, 403)
    if (c.var.principal.role === 'viewer')
      return c.json({ error: 'forbidden', message: '只读成员不能修改' }, 403)
    await next()
  })
  if (!external) return app
  return app
    .get('/api/mcp/external', (c) => c.json(external.status() satisfies ExternalMcpStatus))
    .post('/api/mcp/external', (c) =>
      c.json(external.issue(c.var.principal.id) satisfies ExternalMcpToken, 201),
    )
    .delete('/api/mcp/external', (c) => {
      external.revoke()
      return c.body(null, 204)
    })
}

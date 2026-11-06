import {
  type ExternalMcpAuditEntry,
  type ExternalMcpStatus,
  type ExternalMcpToken,
  IssueExternalMcpToken,
} from '@plein/protocol'
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
  return (
    app
      .get('/api/mcp/external', (c) => c.json(external.status() satisfies ExternalMcpStatus))
      // 新增一枚令牌（带名称与权限范围），已有令牌不受影响
      .post('/api/mcp/external', async (c) => {
        const body = IssueExternalMcpToken.safeParse(await c.req.json().catch(() => ({})))
        if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
        return c.json(external.issue(c.var.principal.id, body.data) satisfies ExternalMcpToken, 201)
      })
      // 撤销全部令牌，关闭外部访问
      .delete('/api/mcp/external', (c) => {
        external.revoke()
        return c.body(null, 204)
      })
      .delete('/api/mcp/external/:id', (c) =>
        external.revokeOne(c.req.param('id'))
          ? c.body(null, 204)
          : c.json({ error: 'not_found', message: '没有这枚令牌' }, 404),
      )
      // 最近的调用记录（工具名、令牌名、结果，不含参数）
      .get('/api/mcp/external/audit', (c) =>
        c.json(
          external.recentAudit(
            Math.min(500, Number(c.req.query('limit') ?? 100) || 100),
          ) satisfies ExternalMcpAuditEntry[],
        ),
      )
  )
}

import {
  type ExternalMcpStatus,
  type ExternalMcpToken,
  McpServerInput,
  type McpServerView,
  type McpToolInfo,
} from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { type McpClients, McpError } from './clients'
import type { ExternalMcp } from './external'
import { McpConfigError, viewOf } from './store'

/**
 * 外部 MCP 服务的设置接口。只在本机免登录模式（含桌面端）开放：
 * stdio 服务等于在服务端所在机器上执行命令，http 服务等于让服务端去访问任意地址。
 */
export function mcpRoutes(clients: McpClients | null, external: ExternalMcp | null) {
  const off = { error: 'disabled', message: '外部 MCP 服务只在本机模式可用' }
  const notFound = { error: 'not_found', message: 'MCP 服务不存在' }
  const app = new Hono<AuthEnv>()
  app.use('/api/mcp/*', async (c, next) => {
    if (!clients) return c.json(off, 403)
    if (c.var.principal.role === 'viewer')
      return c.json({ error: 'forbidden', message: '只读成员不能修改' }, 403)
    await next()
  })
  if (!clients || !external) return app
  const parse = async (body: Promise<unknown>) =>
    McpServerInput.safeParse(await body.catch(() => null))

  return app
    .get('/api/mcp/external', (c) => c.json(external.status() satisfies ExternalMcpStatus))
    .post('/api/mcp/external', (c) =>
      c.json(external.issue(c.var.principal.id) satisfies ExternalMcpToken, 201),
    )
    .delete('/api/mcp/external', (c) => {
      external.revoke()
      return c.body(null, 204)
    })
    .get('/api/mcp/servers', (c) =>
      c.json(clients.store.list().map(viewOf) satisfies McpServerView[]),
    )
    .post('/api/mcp/servers', async (c) => {
      const input = await parse(c.req.json())
      if (!input.success) return c.json({ error: 'invalid', message: input.error.message }, 400)
      try {
        return c.json(viewOf(clients.store.create(input.data)) satisfies McpServerView, 201)
      } catch (err) {
        if (err instanceof McpConfigError)
          return c.json({ error: 'invalid', message: err.message }, 400)
        throw err
      }
    })
    .put('/api/mcp/servers/:id', async (c) => {
      const input = await parse(c.req.json())
      if (!input.success) return c.json({ error: 'invalid', message: input.error.message }, 400)
      try {
        const updated = clients.store.update(c.req.param('id'), input.data)
        if (!updated) return c.json(notFound, 404)
        await clients.disconnect(updated.id)
        return c.json(viewOf(updated) satisfies McpServerView)
      } catch (err) {
        if (err instanceof McpConfigError)
          return c.json({ error: 'invalid', message: err.message }, 400)
        throw err
      }
    })
    .delete('/api/mcp/servers/:id', async (c) => {
      const id = c.req.param('id')
      if (!clients.store.remove(id)) return c.json(notFound, 404)
      await clients.disconnect(id)
      return c.body(null, 204)
    })
    .get('/api/mcp/servers/:id/tools', async (c) => {
      const id = c.req.param('id')
      if (!clients.store.get(id)) return c.json(notFound, 404)
      try {
        const tools = await clients.tools(id, c.req.query('refresh') === '1')
        return c.json(tools satisfies McpToolInfo[])
      } catch (err) {
        if (err instanceof McpError)
          return c.json({ error: 'unavailable', message: err.message }, 502)
        throw err
      }
    })
}

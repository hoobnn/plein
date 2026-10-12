import { CreateAgentSession, SendAgentMessage } from '@plein/protocol'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../http/canvases'
import type { DB } from '../storage/db'
import { AgentError, type AgentSessions } from './sessions'

const STATUS: Record<AgentError['code'], 400 | 403 | 404 | 409 | 503> = {
  not_found: 404,
  busy: 409,
  disabled: 403,
  not_installed: 400,
  not_ready: 503,
}

/** 智能体会话接口（需登录态，走 /api 鉴权） */
export function agentRoutes(db: DB, agents: AgentSessions) {
  const notFound = { error: 'not_found', message: '会话不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能使用智能体' }

  return new Hono<AuthEnv>()
    .get('/api/agent', async (c) => c.json(await agents.status(c.req.query('refresh') === '1')))
    .get('/api/canvases/:canvas/agent/sessions', (c) => {
      const canvas = c.req.param('canvas')
      if (!ownsCanvas(db, c.var.principal.id, canvas)) return c.json(notFound, 404)
      return c.json(agents.list(canvas, c.var.principal.id))
    })
    .post('/api/canvases/:canvas/agent/sessions', async (c) => {
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      const canvas = c.req.param('canvas')
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = CreateAgentSession.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid_input', message: '参数不对' }, 400)
      return c.json(agents.create(canvas, p.id, body.data.agent), 201)
    })
    .get('/api/agent/sessions/:id', (c) => {
      const s = agents.get(c.req.param('id'), c.var.principal.id)
      return s ? c.json(s) : c.json(notFound, 404)
    })
    .delete('/api/agent/sessions/:id', (c) =>
      agents.delete(c.req.param('id'), c.var.principal.id)
        ? c.body(null, 204)
        : c.json(notFound, 404),
    )
    .post('/api/agent/sessions/:id/messages', async (c) => {
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      const body = SendAgentMessage.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid_input', message: '消息不能为空' }, 400)
      try {
        await agents.send(c.req.param('id'), p.id, body.data.text, body.data.selection)
        return c.body(null, 202)
      } catch (err) {
        if (!(err instanceof AgentError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code])
      }
    })
    .post('/api/agent/sessions/:id/stop', (c) => {
      const id = c.req.param('id')
      if (!agents.get(id, c.var.principal.id)) return c.json(notFound, 404)
      agents.stop(id)
      return c.body(null, 204)
    })
    .get('/api/agent/sessions/:id/events', (c) => {
      const id = c.req.param('id')
      const session = agents.get(id, c.var.principal.id)
      if (!session) return c.json(notFound, 404)
      return streamSSE(c, async (stream) => {
        const queue: string[] = []
        let wake: (() => void) | null = null
        const unsubscribe = agents.subscribe(id, (e) => {
          queue.push(JSON.stringify(e))
          wake?.()
        })
        stream.onAbort(() => {
          unsubscribe()
          wake?.()
        })
        await stream.writeSSE({ data: JSON.stringify({ type: 'session', session }) })
        while (!stream.aborted) {
          while (queue.length) await stream.writeSSE({ data: queue.shift()! })
          // 没有事件时 25 秒发一次注释保活，防止代理断开空闲连接
          await Promise.race([
            new Promise<void>((r) => {
              wake = r
            }),
            stream
              .sleep(25_000)
              .then(() => (stream.aborted ? undefined : stream.write(': ping\n\n'))),
          ])
          wake = null
        }
        unsubscribe()
      })
    })
}

/**
 * 智能体调用画布工具的 MCP 入口。CLI 不带浏览器 Cookie，
 * 用会话令牌（Authorization: Bearer）鉴权，令牌只在服务端内存里、随会话生成。
 */
export function agentMcpRoute(agents: AgentSessions) {
  return (
    new Hono()
      .post('/mcp', async (c) => {
        const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim()
        const body = await c.req.json().catch(() => undefined)
        if (!token) return c.json({ error: 'unauthorized' }, 401)
        if (body === undefined) {
          return c.json(
            { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
            400,
          )
        }
        const out = await agents.handleMcp(token, body)
        if (out === undefined) return c.json({ error: 'unauthorized' }, 401)
        return out === null ? c.body(null, 202) : c.json(out)
      })
      // 无状态服务：不提供服务端推送流，也没有会话可删
      .on(['GET', 'DELETE'], '/mcp', (c) => c.body(null, 405))
  )
}

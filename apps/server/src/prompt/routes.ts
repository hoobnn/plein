import { API, RewritePrompt, type RewritePromptResult } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { PluginHost } from '../plugins/host'
import { PromptError, rewritePrompt } from './rewrite'

export function promptRoutes(host: PluginHost) {
  return new Hono<AuthEnv>().post(API.promptRewrite, async (c) => {
    if (c.var.principal.role === 'viewer')
      return c.json({ error: 'forbidden', message: '只读成员不能改写提示词' }, 403)
    const body = RewritePrompt.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
    try {
      const result = await rewritePrompt(host, body.data, {
        ownerId: c.var.principal.id,
        signal: c.req.raw.signal,
      })
      return c.json(result satisfies RewritePromptResult)
    } catch (err) {
      if (!(err instanceof PromptError)) throw err
      return c.json({ error: err.code, message: err.message }, err.status)
    }
  })
}

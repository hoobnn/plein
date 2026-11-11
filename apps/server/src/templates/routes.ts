import { randomBytes } from 'node:crypto'
import { API, CreateTemplate } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { DB } from '../storage/db'
import { deleteTemplate, insertTemplate, listTemplates } from './store'

type TemplateRow = {
  id: string
  title: string
  data: string
  created_at: number
}

/** 一个模板的上限：元素数由 schema 限制，这里再限制总大小 */
const MAX_BYTES = 2 * 1024 * 1024

/** 用户模板：Frame 存为模板后，在节点选择器里整组铺出 */
export function templateRoutes(db: DB) {
  const notFound = { error: 'not_found', message: '模板不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能保存模板' }
  return new Hono<AuthEnv>()
    .get(API.templates, (c) => {
      return c.json(listTemplates(db, c.var.principal.id))
    })
    .post(API.templates, async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const raw = await c.req.text()
      if (raw.length > MAX_BYTES)
        return c.json({ error: 'too_large', message: '模板太大，请减少分组框里的元素' }, 413)
      let input: unknown
      try {
        input = JSON.parse(raw)
      } catch {
        input = null
      }
      const body = CreateTemplate.safeParse(input)
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      const row: TemplateRow = {
        id: `tpl_${randomBytes(9).toString('base64url')}`,
        title: body.data.title,
        data: JSON.stringify(body.data.data),
        created_at: Date.now(),
      }
      return c.json(insertTemplate(db, c.var.principal.id, row), 201)
    })
    .delete('/api/templates/:id', (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const deleted = deleteTemplate(db, c.var.principal.id, c.req.param('id'))
      return deleted ? c.body(null, 204) : c.json(notFound, 404)
    })
}

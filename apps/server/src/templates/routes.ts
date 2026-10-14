import { randomBytes } from 'node:crypto'
import { API, CreateTemplate, type UserTemplate } from '@plein/protocol'
import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import type { DB } from '../storage/db'
import { templates } from '../storage/schema'

type TemplateRow = Omit<typeof templates.$inferSelect, 'owner_id'>

const toTemplate = (r: TemplateRow): UserTemplate => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  data: JSON.parse(r.data),
})

/** 一个模板的上限：元素数由 schema 限制，这里再限制总大小 */
const MAX_BYTES = 2 * 1024 * 1024

/** 用户模板：Frame 存为模板后，在节点选择器里整组铺出 */
export function templateRoutes(db: DB) {
  const notFound = { error: 'not_found', message: '模板不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能保存模板' }
  return new Hono<AuthEnv>()
    .get(API.templates, (c) => {
      const rows = db
        .select({
          id: templates.id,
          title: templates.title,
          data: templates.data,
          created_at: templates.created_at,
        })
        .from(templates)
        .where(eq(templates.owner_id, c.var.principal.id))
        .orderBy(desc(templates.created_at))
        .all()
      return c.json(rows.map(toTemplate))
    })
    .post(API.templates, async (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const raw = await c.req.text()
      if (raw.length > MAX_BYTES)
        return c.json({ error: 'too_large', message: '模板太大，请减少 Frame 里的元素' }, 413)
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
      db.insert(templates)
        .values({ ...row, owner_id: c.var.principal.id })
        .run()
      return c.json(toTemplate(row), 201)
    })
    .delete('/api/templates/:id', (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      const res = db
        .delete(templates)
        .where(and(eq(templates.id, c.req.param('id')), eq(templates.owner_id, c.var.principal.id)))
        .run()
      return res.changes ? c.body(null, 204) : c.json(notFound, 404)
    })
}

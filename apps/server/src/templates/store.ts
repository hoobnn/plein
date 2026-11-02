import { and, desc, eq } from 'drizzle-orm'
import type { UserTemplate } from '@plein/protocol'
import type { DB } from '../storage/db'
import { templates } from '../storage/schema'

type TemplateRow = Omit<typeof templates.$inferSelect, 'owner_id'>

const toTemplate = (r: TemplateRow): UserTemplate => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  data: JSON.parse(r.data),
})

/** 某人的模板列表：按创建时间倒序 */
export function listTemplates(db: DB, ownerId: string): UserTemplate[] {
  const rows = db
    .select({
      id: templates.id,
      title: templates.title,
      data: templates.data,
      created_at: templates.created_at,
    })
    .from(templates)
    .where(eq(templates.owner_id, ownerId))
    .orderBy(desc(templates.created_at))
    .all()
  return rows.map(toTemplate)
}

/** 存一个模板；返回落库后的模板 */
export function insertTemplate(db: DB, ownerId: string, row: TemplateRow): UserTemplate {
  db.insert(templates)
    .values({ ...row, owner_id: ownerId })
    .run()
  return toTemplate(row)
}

/** 删掉自己的某个模板；删掉了返回 true */
export function deleteTemplate(db: DB, ownerId: string, id: string): boolean {
  const res = db
    .delete(templates)
    .where(and(eq(templates.id, id), eq(templates.owner_id, ownerId)))
    .run()
  return res.changes > 0
}

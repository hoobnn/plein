import { and, desc, eq } from 'drizzle-orm'
import type { DB } from '../storage/db'
import { agentSessions } from '../storage/schema'

/** 会话表的一行 */
export type SessionRow = typeof agentSessions.$inferSelect

/**
 * 会话读写的存储模块：业务层只拿结构化数据，不直接 import Drizzle。
 * 见 CONTRIBUTING.md「结构调整约定 › 数据访问」。
 */
export class SessionStore {
  constructor(private db: DB) {}

  /** 某块画布上某个用户的会话，最近更新的在前 */
  list(canvasId: string, ownerId: string): SessionRow[] {
    return this.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.canvas_id, canvasId), eq(agentSessions.owner_id, ownerId)))
      .orderBy(desc(agentSessions.updated_at))
      .limit(50)
      .all()
  }

  find(id: string): SessionRow | undefined {
    return this.db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()
  }

  insert(row: SessionRow): void {
    this.db.insert(agentSessions).values(row).run()
  }

  /** 存下会话当前对外可见的状态 */
  save(row: SessionRow): void {
    const {
      cli_session,
      title,
      items,
      updated_at,
      settings,
      context,
      context_cutoff,
      context_reset_at,
      context_summary,
    } = row
    this.db
      .update(agentSessions)
      .set({
        cli_session,
        title,
        items,
        updated_at,
        settings,
        context,
        context_cutoff,
        context_reset_at,
        context_summary,
      })
      .where(eq(agentSessions.id, row.id))
      .run()
  }

  remove(id: string): void {
    this.db.delete(agentSessions).where(eq(agentSessions.id, id)).run()
  }
}

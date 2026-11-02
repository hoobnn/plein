import { and, desc, eq } from 'drizzle-orm'
import type { DB } from '../storage/db'
import { jobs } from '../storage/schema'

/** 旧序列任务里字幕兼容要用的几列 */
export type LegacySubtitleJobRow = {
  id: string
  frozen: string | null
  calls: string
  omit: string | null
}

/**
 * 某人的历史序列任务，新的在前。
 * 只取字幕兼容要重算输入哈希的几列，完整任务记录由 runs/store.ts 管。
 */
export function legacySubtitleJobs(db: DB, ownerId: string): LegacySubtitleJobRow[] {
  return db
    .select({ id: jobs.id, frozen: jobs.frozen, calls: jobs.calls, omit: jobs.cache_omit })
    .from(jobs)
    .where(and(eq(jobs.owner_id, ownerId), eq(jobs.node_type, 'plein/sequence')))
    .orderBy(desc(jobs.created_at))
    .all()
}

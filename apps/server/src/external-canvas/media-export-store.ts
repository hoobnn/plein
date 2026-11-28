import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { ExternalPlatform } from '@plein/protocol'
import type { DB } from '../storage/db'
import { externalMediaExports as table } from '../storage/schema'
import type { PublishedMedia } from './media-provider'

export function mediaExportStore(
  db: DB,
  key: { canvasId: string; provider: ExternalPlatform; target: string; localAssetId: string },
) {
  const where = and(
    eq(table.canvasId, key.canvasId),
    eq(table.provider, key.provider),
    eq(table.target, key.target),
    eq(table.localAssetId, key.localAssetId),
  )
  return {
    begin() {
      db.insert(table)
        .values({ ...key, operationId: randomUUID() })
        .onConflictDoNothing()
        .run()
      return db.select().from(table).where(where).get()!
    },
    confirm(operationId: string, result: PublishedMedia) {
      const updated = db
        .update(table)
        .set({ remoteNodeId: result.nodeId, remoteAssetId: result.assetId })
        .where(and(where, eq(table.operationId, operationId)))
        .run()
      if (updated.changes !== 1) throw new Error('素材导出记录已变化，请刷新核对。')
    },
  }
}

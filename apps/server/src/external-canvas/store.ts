import { and, eq } from 'drizzle-orm'
import type { Conn } from '../storage/db'
import { externalCanvasLinks as table } from '../storage/schema'
import type { ExternalTarget, ExternalContent } from '@plein/protocol'

export type Link = typeof table.$inferInsert
export function linkStore(db: Conn, canvasId: string) {
  const scope = (ref: ExternalTarget) =>
    and(
      eq(table.canvasId, canvasId),
      eq(table.provider, ref.provider),
      eq(table.target, ref.target),
    )
  return {
    targets: () =>
      db
        .selectDistinct({ provider: table.provider, target: table.target })
        .from(table)
        .where(eq(table.canvasId, canvasId))
        .all(),
    list: (ref: ExternalTarget) => db.select().from(table).where(scope(ref)).all(),
    save: (link: Link) =>
      db
        .insert(table)
        .values(link)
        .onConflictDoUpdate({
          target: [table.canvasId, table.provider, table.target, table.localId],
          set: { remoteId: link.remoteId ?? null, baseline: link.baseline },
        })
        .run(),
    updateBaseline: (ref: ExternalTarget, localId: string, baseline: ExternalContent) =>
      db
        .update(table)
        .set({ baseline })
        .where(and(scope(ref), eq(table.localId, localId)))
        .run(),
    forget: (ref: ExternalTarget, localId: string) =>
      db
        .delete(table)
        .where(and(scope(ref), eq(table.localId, localId)))
        .run(),
  }
}

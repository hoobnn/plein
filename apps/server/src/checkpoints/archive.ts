import { PackageJob, type PackageMissing } from '@plein/protocol'
import { z } from 'zod'
import type { DB } from '../storage/db'
import { documentReferences, readDocument } from '../media-index/references'

export interface CheckpointRow {
  id: string
  owner_id: string
  project_id: string
  source_canvas_id: string | null
  source_canvas_title: string
  name: string
  state: Buffer
  history: string
  created_at: number
  content_hash: string
}

export const CheckpointArchive = z.object({
  version: z.literal(1),
  state: z
    .string()
    .min(1)
    .max(96 * 1024 * 1024),
  history: z.array(PackageJob).max(100_000),
})
export type CheckpointArchive = z.infer<typeof CheckpointArchive>

export function checkpointArchive(row: CheckpointRow): CheckpointArchive {
  return {
    version: 1,
    state: Buffer.from(row.state).toString('base64'),
    history: JSON.parse(row.history),
  }
}

export function parseCheckpointArchive(value: unknown): CheckpointArchive {
  const archive = CheckpointArchive.parse(value)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(archive.state)) throw new Error('检查点文档编码无效')
  readDocument(Buffer.from(archive.state, 'base64'), () => {})
  return archive
}

export function checkpointRows(db: DB, owner: string, projectId: string): CheckpointRow[] {
  return db.$client
    .prepare(
      'SELECT * FROM canvas_checkpoints WHERE owner_id=? AND project_id=? ORDER BY created_at,id',
    )
    .all(owner, projectId) as CheckpointRow[]
}

export function checkpointAssetIds(state: Uint8Array, owns: (id: string) => boolean) {
  const refs = readDocument(state, documentReferences)
  const ids = new Set<string>(),
    missing = new Set<string>()
  for (const ref of refs) {
    if (owns(ref.assetId)) ids.add(ref.assetId)
    else if (ref.explicit) missing.add(ref.assetId)
  }
  return { ids: [...ids], missing: [...missing] }
}

export function checkpointMissing(ids: readonly string[], name: string): PackageMissing[] {
  return ids.map((id) => ({ kind: 'asset', id, where: `检查点 / ${name}` }))
}

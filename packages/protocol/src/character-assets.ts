import { z } from 'zod'
import type { LibraryItem } from './library'

export const CharacterImageSlot = z.enum(['full_body', 'portrait', 'face_grid', 'character_3view'])
export type CharacterImageSlot = z.infer<typeof CharacterImageSlot>

/** Compare the exact displayed target, including image edits made within the same millisecond. */
export function characterImageRevision(item: LibraryItem): string {
  return JSON.stringify([
    'character-image-v1',
    item.id,
    item.kind,
    item.projectId,
    item.name,
    item.updatedAt,
    item.images,
    item.coverAssetId ?? null,
  ])
}

export const ArchiveCharacterImage = z.object({
  canvasId: z.string().min(1).max(200),
  nodeId: z.string().min(1).max(200),
  resultId: z.string().min(1).max(200),
  assetId: z.string().regex(/^[0-9a-f]{64}$/),
  sourceSlot: CharacterImageSlot,
  slot: CharacterImageSlot,
  expected: z.string().min(1).max(20_000),
  cover: z.boolean().default(false),
})
export type ArchiveCharacterImage = z.input<typeof ArchiveCharacterImage>

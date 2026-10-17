import { z } from 'zod'

export const LibrarySyncField = z.enum(['name', 'description', 'voice', 'profile', 'references'])
export type LibrarySyncField = z.infer<typeof LibrarySyncField>
export interface LibraryCardUpdate {
  canvasId: string
  canvasTitle: string
  nodeId: string
  name: string
  expected: string
  pinned: boolean
  revision: string | null
  changes: Array<{ field: LibrarySyncField; before: unknown; after: unknown }>
}
export interface LibraryUpdates {
  revision: string
  cards: LibraryCardUpdate[]
}
export interface LibrarySyncResult {
  updated: number
  persistence: 'saved' | 'pending'
  pendingCanvases: string[]
}
export const ApplyLibraryUpdates = z.object({
  revision: z.string().min(1),
  targets: z
    .array(
      z.object({
        canvasId: z.string().min(1),
        nodeId: z.string().min(1),
        expected: z.string().min(1),
        mode: z.enum(['update', 'keep', 'unpin']).default('update'),
        fields: z.array(LibrarySyncField).min(1).optional(),
      }),
    )
    .min(1)
    .max(200),
})
export type ApplyLibraryUpdates = z.infer<typeof ApplyLibraryUpdates>

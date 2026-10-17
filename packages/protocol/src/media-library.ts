import { z } from 'zod'
import type { Asset } from './assets'

export const MediaLibraryQuery = z.object({
  projectId: z.string().min(1).max(100).optional(),
  kind: z.enum(['image', 'video', 'audio']).optional(),
  q: z.string().trim().max(200).default(''),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type MediaLibraryQuery = z.infer<typeof MediaLibraryQuery>

export interface MediaSource {
  type: 'canvas' | 'job' | 'library' | 'checkpoint'
  id: string
  locator: string
  projectId: string | null
  canvasId: string | null
  nodeId: string | null
  resultId: string | null
  label: string
  createdAt: number
  adopted: boolean
  /** 有现存的画布节点可以定位；任务或检查点本身仍可读取。 */
  locatable: boolean
}

export interface MediaLibraryItem extends Asset {
  sourceCount: number
  sources: MediaSource[]
}

export interface MediaLibraryPage {
  items: MediaLibraryItem[]
  nextCursor: string | null
}

export interface MediaSourcesPage {
  items: MediaSource[]
  nextCursor: string | null
}

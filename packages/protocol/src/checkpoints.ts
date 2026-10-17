import { z } from 'zod'

export const CreateCheckpoint = z.object({
  name: z.string().trim().min(1).max(100),
  /** base64(Y.encodeSnapshot(Y.snapshot(doc)))，同时包含时钟和删除集。 */
  expectedSnapshot: z
    .string()
    .min(1)
    .max(4 * 1024 * 1024),
})
export type CreateCheckpoint = z.infer<typeof CreateCheckpoint>

export const RestoreCheckpoint = z.object({ title: z.string().trim().min(1).max(200).optional() })
export type RestoreCheckpoint = z.infer<typeof RestoreCheckpoint>

export const CheckpointQuery = z.object({
  canvasId: z.string().min(1).max(100).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type CheckpointQuery = z.infer<typeof CheckpointQuery>

export interface CanvasCheckpoint {
  id: string
  projectId: string
  sourceCanvasId: string | null
  sourceCanvasTitle: string
  name: string
  createdAt: number
  assets: number
  missingAssets: string[]
}

export interface CheckpointPage {
  items: CanvasCheckpoint[]
  nextCursor: string | null
}

export interface CheckpointDetail extends CanvasCheckpoint {
  /** 只读预览使用的新文档状态，不含执行中的 run 状态。 */
  state: string
}

export interface CheckpointRestored {
  canvasId: string
}

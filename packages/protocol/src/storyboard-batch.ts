import { z } from 'zod'
import type { PreparedInput } from './runs'

export const StoryboardBatchRequest = z.object({
  shotIds: z.array(z.string().min(1).max(200)).min(1).max(500),
  role: z.enum(['image', 'video', 'speech', 'sfx']),
  /** 补齐未完成项时保留所有已有采用结果；所选或全新候选模式则重新生成目标。 */
  reuseExisting: z.boolean().default(true),
})
export type StoryboardBatchRequest = z.infer<typeof StoryboardBatchRequest>

export interface StoryboardBatchRow {
  key: string
  nodeId?: string
  shotId?: string
  shotNo?: number
  name: string
  prerequisite: boolean
  action: 'run' | 'reuse' | 'blocked' | 'skip'
  reason: string
  /** 参考资产准备后才可确定最终输入，执行前再次复核。 */
  deferred?: boolean
  calls: number
  input?: PreparedInput
  price?: { amount: number; currency: string }
}

export interface StoryboardBatchPlan {
  token: string
  expiresAt: number
  sourceId: string
  request: StoryboardBatchRequest
  rows: StoryboardBatchRow[]
  summary: {
    run: number
    reuse: number
    blocked: number
    skip: number
    /** 本次任务预计的模型调用次数，不含自动重试，非实际账单。 */
    calls: number
    prices: Array<{ currency: string; amount: number }>
    unknownCalls: number
  }
}

export const CommitStoryboardBatch = z.object({ token: z.string().min(1).max(200) })

import { z } from 'zod'
import { RecoverJobOptions, type JobRecovery } from './recovery'

export const SubtitleRecognizeRequest = z.object({
  model: z.string().min(1),
  assetIds: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .min(1)
    .max(200),
})
export type SubtitleRecognizeRequest = z.infer<typeof SubtitleRecognizeRequest>

export interface SubtitleRecognizeResult {
  transcripts: Record<string, Array<{ start: number; end: number; text: string }>>
}

export const SubtitleRecognitionLookup = z.object({
  model: z.string().min(1),
  assetId: z.string().regex(/^[0-9a-f]{64}$/),
})
export interface SubtitleRecognitionInfo {
  model: string
  assetId: string
  expected: string
  recovery: JobRecovery
}
export const SubtitleRecoverRequest = SubtitleRecognitionLookup.extend({
  expected: z.string().min(1),
  operation: RecoverJobOptions,
  confirmedNotAccepted: z.boolean().default(false),
})
export type SubtitleRecoverRequest = z.input<typeof SubtitleRecoverRequest>

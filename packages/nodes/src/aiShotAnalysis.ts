import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'

export const AI_SCENE_TYPE = 'plein/shot-scene-draft'
export const AI_SUMMARY_TYPE = 'plein/shot-summary-draft'
export const AI_ANALYSIS_LIMITS = {
  scenes: 3,
  jobsPerNode: 2,
  frameBytes: 8 * 1024 * 1024,
  focus: 1000,
} as const
export const isAiAnalysisType = (type: string | undefined) =>
  type === AI_SCENE_TYPE || type === AI_SUMMARY_TYPE
const id = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const image = z.object({ assetId: hash, kind: z.literal('image'), mime: z.literal('image/jpeg') })
const video = z.object({
  assetId: hash,
  kind: z.literal('video'),
  mime: z
    .string()
    .regex(/^video\/[\w.+-]+$/)
    .max(100),
})
export const AiLocalScope = z
  .object({
    origin: z.object({ canvasId: id, nodeId: id, resultId: id, digest: hash }),
    source: video,
    duration: z.number().positive().max(600),
    firstVideoPts: z.number().finite(),
    totalScenes: z.number().int().min(1).max(100),
    timeBasis: z.literal('first-video-frame'),
    scene: z.object({
      id,
      start: z.number().nonnegative(),
      end: z.number().positive(),
      frame: image.extend({
        at: z.number().nonnegative(),
        actualAt: z.number().nonnegative().optional(),
        actualEnd: z.number().positive().optional(),
      }),
    }),
  })
  .superRefine((scope, ctx) => {
    const { scene } = scope
    if (
      scene.start >= scene.end ||
      scene.end > scope.duration ||
      scene.frame.at < scene.start ||
      scene.frame.at >= scene.end ||
      (scene.frame.actualAt === undefined) !== (scene.frame.actualEnd === undefined) ||
      (scene.frame.actualAt !== undefined &&
        scene.frame.actualEnd !== undefined &&
        (scene.frame.actualAt > scene.frame.at + 1e-6 ||
          scene.frame.actualEnd <= scene.frame.at ||
          scene.frame.actualEnd > scope.duration + 1e-6))
    )
      ctx.addIssue({ code: 'custom', path: ['scene'], message: '来源区间或实际采样帧不合法' })
  })
export type AiLocalScope = z.infer<typeof AiLocalScope>
const requestBase = { id, modelRef: id, focus: z.string().max(AI_ANALYSIS_LIMITS.focus) }
export const AiSceneRequest = z.object({ ...requestBase, scope: AiLocalScope })
export type AiSceneRequest = z.infer<typeof AiSceneRequest>
export const AiSceneContent = z
  .object({
    description: z.string().min(1).max(2000),
    visualDraft: z.array(z.string().max(500)).max(8),
    inferences: z.array(z.string().max(500)).max(8),
    unknowns: z.array(z.string().max(500)).max(8),
  })
  .strict()
export const AiSceneResult = z.object({
  version: z.literal(1),
  kind: z.literal('ai-scene-draft'),
  promptVersion: z.literal('sample-frame-v1'),
  model: z.object({ ref: id, declaredVersion: z.string().max(200).optional() }),
  request: AiSceneRequest,
  evidence: z.object({
    visual: z.literal('one-frame-submitted'),
    motion: z.literal('unknown'),
    audio: z.literal('unknown'),
    fullVideoRead: z.literal(false),
  }),
  draft: AiSceneContent,
})
export type AiSceneResult = z.infer<typeof AiSceneResult>
export const AiDraftReference = z.object({
  origin: z.object({ canvasId: id, nodeId: id, resultId: id }),
  value: AiSceneResult,
})
export type AiDraftReference = z.infer<typeof AiDraftReference>
export const AiSummaryRequest = z
  .object({ ...requestBase, drafts: z.array(AiDraftReference).min(1).max(3) })
  .superRefine((request, ctx) => {
    const first = request.drafts[0]!.value.request.scope
    if (
      new Set(request.drafts.map((draft) => draft.value.request.scope.scene.id)).size !==
        request.drafts.length ||
      request.drafts.some(
        (draft) =>
          draft.value.request.scope.origin.digest !== first.origin.digest ||
          draft.value.request.scope.origin.canvasId !== first.origin.canvasId ||
          draft.value.request.scope.origin.nodeId !== first.origin.nodeId ||
          draft.value.request.scope.origin.resultId !== first.origin.resultId ||
          draft.value.request.scope.source.assetId !== first.source.assetId,
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['drafts'],
        message: '归纳必须来自同一固定本地清单且镜头不重复',
      })
  })
export type AiSummaryRequest = z.infer<typeof AiSummaryRequest>
export const AiSummaryContent = z
  .object({
    summary: z.string().min(1).max(4000),
    inferences: z.array(z.string().max(500)).max(8),
    unknowns: z.array(z.string().max(500)).max(8),
  })
  .strict()
export const AiSummaryResult = z.object({
  version: z.literal(1),
  kind: z.literal('ai-summary-draft'),
  promptVersion: z.literal('scene-summary-v1'),
  model: z.object({ ref: id, declaredVersion: z.string().max(200).optional() }),
  request: AiSummaryRequest,
  evidence: z.object({
    input: z.literal('model-draft-text-only'),
    motion: z.literal('unknown'),
    audio: z.literal('unknown'),
    fullVideoRead: z.literal(false),
  }),
  draft: AiSummaryContent,
})
export type AiSummaryResult = z.infer<typeof AiSummaryResult>
export const AiDraftOrigin = z.object({
  version: z.literal(1),
  kind: z.literal('ai-shot-draft-origin'),
  drafts: z.array(AiDraftReference).min(1).max(3),
})
export type AiDraftOrigin = z.infer<typeof AiDraftOrigin>

// The dedicated review UI owns model selection; withDefaultModel must not fill a model here.
const model = z.string().default('').meta({ title: '模型', widget: 'hidden' })
export const aiSceneNode = defineNode({
  type: AI_SCENE_TYPE,
  version: 1,
  title: 'AI 逐镜草稿',
  category: 'text',
  capability: 'text.chat',
  inputs: [],
  outputs: [{ id: 'draft', label: '模型分析草稿', type: 'json' }],
  params: z.object({ model, request: AiSceneRequest.optional().meta({ widget: 'hidden' }) }),
})
export const aiSummaryNode = defineNode({
  type: AI_SUMMARY_TYPE,
  version: 1,
  title: 'AI 采样归纳',
  category: 'text',
  capability: 'text.chat',
  inputs: [],
  outputs: [{ id: 'draft', label: '模型归纳草稿', type: 'json' }],
  params: z.object({ model, request: AiSummaryRequest.optional().meta({ widget: 'hidden' }) }),
})

export function aiAnalysisAssets(value: unknown): string[] {
  const scene = AiSceneResult.safeParse(value)
  const summary = AiSummaryResult.safeParse(value)
  const origin = AiDraftOrigin.safeParse(value)
  const scopes = scene.success
    ? [scene.data.request.scope]
    : summary.success
      ? summary.data.request.drafts.map((d) => d.value.request.scope)
      : origin.success
        ? origin.data.drafts.map((d) => d.value.request.scope)
        : []
  return [...new Set(scopes.flatMap((scope) => [scope.source.assetId, scope.scene.frame.assetId]))]
}

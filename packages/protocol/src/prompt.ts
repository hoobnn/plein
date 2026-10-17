import { z } from 'zod'

/**
 * 用已启用的对话模型改写提示词：
 * - optimize：按目标（出图 / 视频）补全主体、景别、光线、运镜等；
 * - translate：中英互译。
 * `@引用` 与 `【占位】` 原样保留。
 */
export const RewritePrompt = z.object({
  text: z.string().trim().min(1).max(8000),
  mode: z.enum(['optimize', 'translate']),
  target: z.enum(['image', 'video']).default('image'),
  /** 模型引用 vendor/name:model；不填用第一个已启用的对话模型 */
  model: z.string().optional(),
  /** 改写用的对话模型与最终生成模型分开，后者仅作为创作约束。 */
  generationModel: z.string().max(200).optional(),
  detail: z.enum(['refine', 'expand']).default('expand'),
  inputContext: z
    .object({
      mode: z.string().max(100).optional(),
      references: z.array(z.string().max(200)).max(64),
    })
    .optional(),
  /** 画布上可被 @ 引用的名字，用来识别要原样保留的引用 */
  mentions: z.array(z.string().min(1).max(100)).max(500).optional(),
})
export type RewritePrompt = z.input<typeof RewritePrompt>

export interface RewritePromptResult {
  text: string
  /** 实际使用的模型引用 */
  model: string
}

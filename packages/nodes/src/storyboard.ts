import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'

export const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'] as const

/** 一行分镜。id 稳定，重新生成按镜号对齐 */
export const Shot = z.object({
  id: z.string(),
  no: z.number().int(),
  duration: z.number().min(1).max(30).default(5),
  shotSize: z.enum(SHOT_SIZES).default('中景'),
  /** 画面描述 */
  description: z.string().default(''),
  /** 出场的资产卡名字（角色、场景），展开时作为 @ 引用 */
  characters: z.array(z.string()).default([]),
  emotion: z.string().default(''),
  lighting: z.string().default(''),
  sfx: z.string().default(''),
  dialogue: z.array(z.object({ character: z.string(), line: z.string() })).default([]),
  /** 分镜图提示词 */
  imagePrompt: z.string().default(''),
  /** 视频运动提示词 */
  motionPrompt: z.string().default(''),
  /** 用户手改过：重新生成时不覆盖 */
  edited: z.boolean().optional(),
})
export type Shot = z.infer<typeof Shot>

/** 交给模型的结构：不含 id 和 edited，由宿主补上 */
export const ShotDraft = Shot.omit({ id: true, edited: true })
export const StoryboardDraft = z.object({ shots: z.array(ShotDraft) })

const model = () => z.string().default('').meta({ title: '模型', widget: 'model' })

/** 分镜：剧本 → 结构化分镜表；表格可编辑，可展开成每个镜头一组节点 */
export const STORYBOARD_TYPE = 'plein/storyboard'

export const storyboardNode = defineNode({
  type: STORYBOARD_TYPE,
  version: 1,
  title: '分镜',
  description: '把剧本拆成分镜表（景别、画面、出场角色、台词、提示词），可展开成镜头节点',
  category: 'story',
  capability: 'text.chat',
  inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
  outputs: [{ id: 'shots', label: '分镜', type: 'json' }],
  params: z.object({
    model: model(),
    prompt: z.string().default('').meta({
      title: '要求',
      widget: 'textarea',
      placeholder: '补充要求，如：竖屏短剧节奏，每镜 3–5 秒',
    }),
    shotCount: z.number().int().min(1).max(30).default(8).meta({ title: '镜头数' }),
    shots: z.array(Shot).default([]).meta({ title: '分镜表', widget: 'hidden' }),
  }),
  applyOutputs(params, outputs) {
    const value = outputs.shots?.[0]?.value as { shots?: unknown } | undefined
    const drafts = StoryboardDraft.safeParse(value)
    if (!drafts.success) return undefined
    return { shots: mergeShots(params.shots, drafts.data.shots) }
  },
})

let seq = 0
export const newShotId = () =>
  `shot_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * 新生成的分镜并入现有表格：按镜号对齐，手改过的行保留原样，
 * 其余行换成新内容但沿用原 id（已展开的镜头节点按 id 对应）。
 */
export function mergeShots(current: Shot[], drafts: Array<z.input<typeof ShotDraft>>): Shot[] {
  const byNo = new Map(current.map((s) => [s.no, s]))
  const out: Shot[] = drafts.map((d, i) => {
    const draft = ShotDraft.parse({ ...d, no: d.no ?? i + 1 })
    const old = byNo.get(draft.no)
    if (old?.edited) return old
    return { ...draft, id: old?.id ?? newShotId() }
  })
  // 手改过但新结果里没有的镜头也保留
  const seen = new Set(out.map((s) => s.no))
  for (const s of current) if (s.edited && !seen.has(s.no)) out.push(s)
  return out.sort((a, b) => a.no - b.no)
}

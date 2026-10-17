import { defineNode, type PortValue } from '@plein/plugin-sdk'
import { z } from 'zod'
import { type ArrangedClip, sequenceNode } from './sequence'

export const ANIMATIC_TYPE = 'plein/animatic'
export const AnimaticShot = z.object({
  shotId: z.string().min(1),
  imageSource: z.string().optional(),
  imageAssetId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  duration: z.number().min(0.2).max(300),
  dialogue: z
    .array(
      z.object({
        source: z.string(),
        assetId: z.string().regex(/^[0-9a-f]{64}$/),
        caption: z.string().optional(),
      }),
    )
    .default([]),
  subtitle: z.string().optional(),
  lineDelay: z.number().min(0).max(30).default(0),
  lineGap: z.number().min(0).max(10).default(0.2),
})
export type AnimaticShot = z.infer<typeof AnimaticShot>

/** 素材快照作为本地输入，不连接生成器依赖，也不自动合成配音或识别字幕。 */
export const animaticNode = defineNode({
  type: ANIMATIC_TYPE,
  version: 1,
  title: '分镜节奏样片',
  description: '用已有分镜图、配音和字幕预演节奏，本地导出草稿，不调用视频模型',
  category: 'video',
  execution: 'job',
  inputs: [],
  outputs: [{ id: 'video', label: '样片草稿', type: 'video' }],
  params: sequenceNode.params.extend({
    boardId: z.string().default('').meta({ title: '来源分镜', widget: 'hidden' }),
    shots: z.array(AnimaticShot).default([]).meta({ title: '样片镜头', widget: 'hidden' }),
  }),
})
export type AnimaticParams = z.infer<typeof animaticNode.params>

export function arrangeAnimatic(params: AnimaticParams): ArrangedClip[] {
  const audio = (
    line: AnimaticShot['dialogue'][number],
  ): Extract<PortValue, { assetId: string }> => ({
    type: 'audio',
    kind: 'audio',
    source: line.source,
    assetId: line.assetId,
    caption: line.caption,
  })
  return params.shots.map((shot) => ({
    source: shot.shotId,
    clip: {
      type: 'image',
      kind: 'image',
      assetId: shot.imageAssetId ?? '',
      source: shot.imageSource,
    },
    in: 0,
    out: shot.duration,
    speed: 1,
    volume: 0,
    dialogue: shot.dialogue[0] ? audio(shot.dialogue[0]) : undefined,
    more: shot.dialogue.slice(1).map(audio),
    subtitle: shot.subtitle,
    lineDelay: shot.lineDelay,
    lineGap: shot.lineGap,
  }))
}

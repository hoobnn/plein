import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'
import { characterAssetTargetField } from './characterAssetTarget'

/** 预览、缓存和执行只保留当前操作真正使用的参数。 */
export function imageProcessParams(params: Record<string, unknown>): Record<string, unknown> {
  const effective = { ...params }
  if (params.operation !== 'upscale') delete effective.scale
  if (params.operation !== 'outpaint') {
    delete effective.top
    delete effective.bottom
    delete effective.left
    delete effective.right
  }
  return effective
}

export const imageProcessNode = defineNode({
  type: 'plein/image-process',
  version: 1,
  title: '图片精修',
  category: 'image',
  capability: 'image.process',
  description: 'AI 高清放大、扩图或拆出透明主体图层，保留原图并生成新候选',
  inputs: [{ id: 'image', label: '原图', type: 'image', required: true }],
  outputs: [
    { id: 'images', label: '图片', type: 'image' },
    { id: 'layers', label: '图层信息', type: 'json' },
  ],
  params: z.object({
    model: z.string().default('').meta({ title: '模型', widget: 'model' }),
    characterAssetTarget: characterAssetTargetField(),
    operation: z
      .enum(['upscale', 'outpaint', 'cutout'])
      .default('upscale')
      .meta({
        title: '操作',
        labels: { upscale: 'AI 高清放大', outpaint: '扩图', cutout: '主体抠图（透明图层）' },
      }),
    prompt: z.string().default('').meta({
      title: '要求',
      widget: 'textarea',
      placeholder: '扩图后希望看到的场景，或要拆出的主体',
    }),
    scale: z.number().min(1).max(4).default(2).meta({ title: '放大倍数' }),
    top: z.number().min(1).max(2).default(1).meta({ title: '向上扩展比例' }),
    bottom: z.number().min(1).max(2).default(1).meta({ title: '向下扩展比例' }),
    left: z.number().min(1).max(2).default(1.5).meta({ title: '向左扩展比例' }),
    right: z.number().min(1).max(2).default(1.5).meta({ title: '向右扩展比例' }),
  }),
})

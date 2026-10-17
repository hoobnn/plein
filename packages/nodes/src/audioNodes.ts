import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'

const model = () => z.string().default('').meta({ title: '模型', widget: 'model' })

export const sfxNode = defineNode({
  type: 'plein/sfx',
  version: 1,
  title: '音效',
  description: '按描述生成镜头音效，连入序列的音效端口',
  category: 'audio',
  capability: 'audio.sfx',
  inputs: [{ id: 'prompt', label: '描述', type: 'text', multiple: true }],
  outputs: [{ id: 'audio', label: '音效', type: 'audio' }],
  params: z.object({
    model: model(),
    prompt: z.string().default('').meta({ title: '描述', widget: 'textarea' }),
    duration: z.number().min(1).max(300).default(5).meta({ title: '时长（秒）' }),
  }),
})

export const transcribeNode = defineNode({
  type: 'plein/transcribe',
  version: 1,
  title: '语音识别',
  description: '识别音频，输出全文和以秒为单位的分句时间戳',
  category: 'audio',
  capability: 'audio.transcribe',
  inputs: [{ id: 'audio', label: '音频', type: 'audio', required: true }],
  outputs: [
    { id: 'text', label: '全文', type: 'text' },
    { id: 'segments', label: '分句与时间戳', type: 'json' },
  ],
  params: z.object({
    model: model(),
    language: z.string().default('').meta({ title: '语言', placeholder: '留空由平台识别' }),
  }),
})

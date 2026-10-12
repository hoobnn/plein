import { defineNode, definePlugin, PLUGIN_API_VERSION } from '@plein/plugin-sdk'
import { z } from 'zod'

const model = () => z.string().default('').meta({ title: '模型', widget: 'model' })
const textarea = (title: string, placeholder?: string) =>
  z.string().default('').meta({ title, widget: 'textarea', placeholder })
const ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'] as const

/** 文本：提示词、台词等，下游节点的文本输入 */
export const textNode = defineNode({
  type: 'plein/text',
  version: 1,
  title: '文本',
  description: '手写的提示词或文案，连到下游节点作为文本输入',
  category: 'input',
  inputs: [],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
  params: z.object({ text: textarea('文本', '写下提示词或台词') }),
})

/** 对话模型：生成或改写文本，可附图片 */
export const llmNode = defineNode({
  type: 'plein/llm',
  version: 1,
  title: 'LLM',
  description: '用对话模型生成或改写文本',
  category: 'text',
  capability: 'text.chat',
  inputs: [
    { id: 'prompt', label: '输入', type: 'text', multiple: true },
    { id: 'images', label: '图片', type: 'image', multiple: true },
  ],
  outputs: [{ id: 'text', label: '输出', type: 'text' }],
  params: z.object({
    model: model(),
    system: textarea('系统提示词'),
    prompt: textarea('提示词', '可用上游文本补充'),
    temperature: z.number().min(0).max(2).default(0.7).meta({ title: '温度' }),
  }),
})

/** 文生图 / 参考图生图 */
export const imageNode = defineNode({
  type: 'plein/image',
  version: 1,
  title: '生成图片',
  description: '文生图；连上参考图即为图生图 / 多参考图生图',
  category: 'image',
  capability: 'image.generate',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text', multiple: true },
    { id: 'references', label: '参考图', type: 'image', multiple: true },
  ],
  outputs: [{ id: 'images', label: '图片', type: 'image' }],
  params: z.object({
    model: model(),
    prompt: textarea('提示词'),
    aspectRatio: z.enum(ASPECTS).default('16:9').meta({ title: '画幅' }),
    count: z.number().int().min(1).max(4).default(1).meta({ title: '张数' }),
    seed: z.number().int().optional().meta({ title: '种子' }),
  }),
})

/** 文生视频 / 首帧、首尾帧生视频 */
export const videoNode = defineNode({
  type: 'plein/video',
  version: 1,
  title: '生成视频',
  description: '文生视频；连上首帧（和尾帧）即为图生视频',
  category: 'video',
  capability: 'video.generate',
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text', multiple: true },
    { id: 'firstFrame', label: '首帧', type: 'image' },
    { id: 'lastFrame', label: '尾帧', type: 'image' },
  ],
  outputs: [{ id: 'video', label: '视频', type: 'video' }],
  params: z.object({
    model: model(),
    prompt: textarea('提示词'),
    duration: z.number().int().min(1).max(30).default(5).meta({ title: '时长（秒）' }),
    aspectRatio: z.enum(ASPECTS).default('16:9').meta({ title: '画幅' }),
    seed: z.number().int().optional().meta({ title: '种子' }),
  }),
})

/** 配音：语音合成 */
export const speechNode = defineNode({
  type: 'plein/speech',
  version: 1,
  title: '配音',
  description: '把台词合成为语音，可用自然语言指定情绪',
  category: 'audio',
  capability: 'audio.speech',
  inputs: [{ id: 'text', label: '台词', type: 'text', multiple: true }],
  outputs: [{ id: 'audio', label: '语音', type: 'audio' }],
  params: z.object({
    model: model(),
    text: textarea('台词'),
    voice: z.string().default('').meta({ title: '音色' }),
    instruction: z
      .string()
      .default('')
      .meta({ title: '语气指令', placeholder: '如：压低声音，带着哭腔' }),
  }),
})

/** 配乐 / 音效 */
export const musicNode = defineNode({
  type: 'plein/music',
  version: 1,
  title: '配乐',
  description: '按描述生成背景音乐',
  category: 'audio',
  capability: 'audio.music',
  inputs: [{ id: 'prompt', label: '描述', type: 'text', multiple: true }],
  outputs: [{ id: 'audio', label: '音乐', type: 'audio' }],
  params: z.object({
    model: model(),
    prompt: textarea('描述', '如：紧张的弦乐，渐强'),
    duration: z.number().int().min(5).max(300).default(30).meta({ title: '时长（秒）' }),
  }),
})

/** 内置核心插件：只有声明，执行器在服务端（apps/server/src/executors） */
export const corePlugin = definePlugin({
  manifest: {
    id: 'plein/core',
    version: '0.1.0',
    name: '基础节点',
    description: '文本、LLM、图片、视频、配音、配乐等与平台无关的基础节点',
    engines: { plein: `^${PLUGIN_API_VERSION}` },
    contributes: {
      nodes: [
        'plein/text@1',
        'plein/llm@1',
        'plein/image@1',
        'plein/video@1',
        'plein/speech@1',
        'plein/music@1',
      ],
    },
  },
  nodes: [textNode, llmNode, imageNode, videoNode, speechNode, musicNode],
})

import {
  type Capability,
  type CapabilityInput,
  defineProvider,
  definePlugin,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  ProviderError,
  type ProviderOutput,
  type ProviderRequest,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { colorOf, sineWav, solidPng } from './media'
import { MOCK_WEBM_BASE64 } from './video-fixture'

const ASPECT: Record<string, [number, number]> = {
  '16:9': [256, 144],
  '9:16': [144, 256],
  '1:1': [192, 192],
  '4:3': [224, 168],
  '3:4': [168, 224],
  '21:9': [280, 120],
  '3:2': [240, 160],
  '2:3': [160, 240],
}

function lastUserText(input: CapabilityInput<'text.chat'>) {
  const msg = [...input.messages].reverse().find((m) => m.role === 'user')
  if (!msg) return ''
  return typeof msg.content === 'string'
    ? msg.content
    : msg.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
}

/** 分镜请求：按句拆剧本，每句一个镜头 */
function mockStoryboard(text: string) {
  const script = /<剧本>([\s\S]*?)<\/剧本>/.exec(text)?.[1] ?? text
  const sizes = ['全景', '中景', '近景', '特写'] as const
  const lines = script
    .split(/[。！？!?\n]/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1)
    .slice(0, 12)
  return {
    shots: lines.map((line, i) => ({
      no: i + 1,
      duration: 4,
      shotSize: sizes[i % sizes.length],
      description: line,
      characters: [],
      emotion: '',
      lighting: '',
      sfx: '',
      dialogue: [],
      imagePrompt: `【mock】${line}`,
      motionPrompt: '镜头缓慢推近',
    })),
  }
}

/** 按能力生成假结果：不联网、确定性，供开发和测试跑通整条链路 */
function fakeOutputs(req: ProviderRequest): ProviderOutput[] {
  switch (req.capability as Capability) {
    case 'text.chat': {
      const input = req.input as CapabilityInput<'text.chat'>
      const text = lastUserText(input)
      if (input.jsonSchema && 'shots' in ((input.jsonSchema.properties as object) ?? {}))
        return [{ type: 'json', value: mockStoryboard(text) }]
      if (input.jsonSchema) return [{ type: 'json', value: { echo: text } }]
      return [{ type: 'text', text: `【mock】${text}` }]
    }
    case 'image.generate': {
      const input = req.input as CapabilityInput<'image.generate'>
      const aspect = String(input.extra?.aspectRatio ?? '16:9')
      const [w, h] = ASPECT[aspect] ?? ASPECT['16:9']!
      return Array.from({ length: input.count ?? 1 }, (_, i) => ({
        type: 'file' as const,
        kind: 'image' as const,
        mime: 'image/png',
        name: `mock-${i + 1}.png`,
        data: solidPng(w, h, colorOf(`${input.prompt}#${i}#${input.seed ?? ''}`)),
      }))
    }
    case 'video.generate':
      return [
        {
          type: 'file',
          kind: 'video',
          mime: 'video/webm',
          name: 'mock.webm',
          data: new Uint8Array(Buffer.from(MOCK_WEBM_BASE64, 'base64')),
        },
      ]
    case 'audio.speech':
    case 'audio.music':
    case 'audio.sfx': {
      const input = req.input as { duration?: number }
      return [
        {
          type: 'file',
          kind: 'audio',
          mime: 'audio/wav',
          name: 'mock.wav',
          data: sineWav(Math.min(input.duration ?? 1, 3)),
        },
      ]
    }
    case 'audio.transcribe':
      // 两段带时间戳的结果，模拟能校准字幕的识别平台
      return [
        { type: 'text', text: '【mock】识别结果' },
        {
          type: 'json',
          value: {
            segments: [
              { start: 0.1, end: 0.5, text: '【mock】识别' },
              { start: 0.5, end: 0.9, text: '结果' },
            ],
          },
        },
      ]
  }
}

/** 进行中的模拟异步任务 */
const pending = new Map<string, { readyAt: number; req: ProviderRequest }>()
let seq = 0

export const mockProvider = defineProvider({
  id: 'plein/mock',
  title: 'Mock（开发测试用）',
  description: '不联网的假平台，按能力返回固定结果，用来在没有密钥时跑通工作流',
  settings: z.object({
    latencyMs: z.number().int().min(0).max(60_000).default(0).meta({ title: '模拟耗时（毫秒）' }),
    failWith: z
      .enum(['none', 'auth', 'rate_limit', 'content_policy'])
      .default('none')
      .meta({ title: '模拟错误' }),
  }),
  secrets: [
    { name: 'MOCK_API_KEY', title: 'API Key', help: 'mock 不校验密钥，用来演示密钥的存储方式' },
  ],
  models: [
    { id: 'chat', title: 'Mock 对话', capabilities: ['text.chat'] },
    {
      id: 'image',
      title: 'Mock 图片',
      capabilities: ['image.generate'],
      limits: { resolutions: ['1K', '2K'] },
      options: z.object({
        watermark: z.boolean().optional().meta({ title: '水印', description: '仅用于测试表单' }),
      }),
    },
    {
      id: 'video',
      title: 'Mock 视频',
      capabilities: ['video.generate'],
      limits: {
        resolutions: ['480p', '720p', '1080p'],
        duration: { min: 2, max: 10 },
        seed: false,
      },
    },
    {
      id: 'audio',
      title: 'Mock 音频',
      capabilities: ['audio.speech', 'audio.music', 'audio.sfx', 'audio.transcribe'],
    },
  ],
  async test(ctx) {
    if (ctx.settings.failWith === 'auth') throw new ProviderError('auth', '模拟：密钥无效')
  },
  async submit(req, ctx) {
    const fail = ctx.settings.failWith
    if (fail !== 'none') throw new ProviderError(fail, `模拟错误：${fail}`)
    if (ctx.settings.latencyMs === 0) return { state: 'succeeded', outputs: fakeOutputs(req) }
    const remoteId = `mock-${++seq}`
    pending.set(remoteId, { readyAt: Date.now() + ctx.settings.latencyMs, req })
    return {
      state: 'pending',
      remoteId,
      pollAfterMs: Math.min(Math.ceil(ctx.settings.latencyMs / 3), 500),
    }
  },
  async poll(remoteId) {
    const job = pending.get(remoteId)
    if (!job) return { state: 'failed', error: { code: 'unknown', message: '任务不存在' } }
    const left = job.readyAt - Date.now()
    if (left > 0) return { state: 'pending', progress: 0.5, pollAfterMs: Math.min(left, 500) }
    pending.delete(remoteId)
    return { state: 'succeeded', outputs: fakeOutputs(job.req) }
  },
  async cancel(remoteId) {
    pending.delete(remoteId)
  },
})

export const mockPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'plein/mock',
      version: '0.1.0',
      name: 'Mock 平台',
      description: '开发与测试用的假模型平台',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['plein/mock'] },
      permissions: { secrets: ['MOCK_API_KEY'] },
    },
  }),
  { providers: [mockProvider] },
)

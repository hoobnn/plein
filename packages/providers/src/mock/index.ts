import {
  type Capability,
  type CapabilityInput,
  defineProvider,
  definePlugin,
  definePluginCapability,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  ProviderError,
  type ProviderContext,
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

const MOCK_CAST = `## 角色
### 林晚
- 性别：女
- 外貌与年龄：二十岁，短发
- 服装：白衬衫
- 辨识特征：左眉有一道疤

### 老周
- 性别：男
- 外貌与年龄：五十多岁，花白头发

## 场景
### 老城区天台
- 时间与地点：雨夜
- 光线与氛围：霓虹反光

## 道具
### 铁盒
- 外观：巴掌大的旧铁盒，挂着铜锁，锈迹斑斑`

/** 分镜请求：按句拆剧本，每句一个镜头 */
function mockStoryboard(text: string) {
  // 连进来的设定清单（## 角色 / ## 场景 / ## 道具）不拆成镜头
  const script = (/<剧本>([\s\S]*?)<\/剧本>/.exec(text)?.[1] ?? text).split(/^##\s/m)[0]!
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
      // 台词里点到名字的角色、道具算出场，展开时镜头会 @ 到这些卡；场景每个镜头都在
      characters: [
        ...(line.includes('林晚') ? ['林晚'] : []),
        ...(text.includes('### 老城区天台') ? ['老城区天台'] : []),
        ...(line.includes('铁盒') && text.includes('### 铁盒') ? ['铁盒'] : []),
      ],
      emotion: '',
      lighting: '',
      sfx: '',
      dialogue: [],
      imagePrompt: `【mock】${line}`,
      motionPrompt: '镜头缓慢推近',
    })),
  }
}

/**
 * 脚本化的智能体对话：每轮先看画布；用户提到图片 / 画就新建一个生成图片节点并运行；最后用一句话收尾。
 * 不联网、确定性，内置智能体的测试和演示不花钱也能跑完整一轮。
 */
function mockAgentStep(input: CapabilityInput<'text.chat'>): ProviderOutput[] {
  const last = input.messages.findLastIndex((m) => m.role === 'user')
  // 去掉宿主加的计划模式说明，只留用户的话（计划模式另外判断）
  const raw = lastUserText(input)
  const ask = raw.replace(/（计划模式[^）]*）\s*/, '')
  const after = input.messages.slice(last + 1)
  const results = after.filter((m) => m.role === 'tool')
  const call = (name: string, args: Record<string, unknown>): ProviderOutput[] => [
    { type: 'tool_calls', calls: [{ id: `call_${after.length}_${name}`, name, arguments: args }] },
  ]
  const text = (m: (typeof results)[number] | undefined) =>
    typeof m?.content === 'string' ? m.content : ''
  if (results.length === 0) return call('get_canvas', {})
  const made = results.find((m) => m.toolName === 'create_node')
  const runIndex = results.findIndex((m) => m.toolName === 'run_node')
  let gated: { status?: string; approval_id?: string } | undefined
  try {
    gated = JSON.parse(text(results[runIndex]) || '{}') as typeof gated
  } catch {
    // 非 JSON 工具结果不代表需要确认。
  }
  const runReply = text(
    results.slice(runIndex + 1).findLast((m) => m.toolName === 'await_approval'),
  )
  const runApproval = gated?.status === 'needs_approval' ? gated.approval_id : undefined
  const waitingForRun = !!runApproval && (!runReply || runReply.includes('"pending"'))
  if (/计划模式/.test(raw)) {
    // 先出计划，等用户同意，再边做边打勾
    const plan = results.find((m) => m.toolName === 'propose_plan')
    if (!plan)
      return call('propose_plan', {
        summary: '新建一个生成图片节点并出图',
        steps: ['新建生成图片节点', '运行出图'],
      })
    const firstUpdate = results.findIndex((m) => m.toolName === 'update_plan')
    // 后续运行可能有自己的确认，不能把它的结果当成计划答复。
    const waits = results
      .slice(0, firstUpdate < 0 ? undefined : firstUpdate)
      .filter((m) => m.toolName === 'await_approval')
    const waited = text(waits.at(-1))
    if (!waits.length || waited.includes('pending'))
      return call('await_approval', {
        approval_id: (JSON.parse(text(plan) || '{}') as { approval_id?: string }).approval_id,
      })
    if (!waited.includes('同意')) return [{ type: 'text', text: '【mock】好的，这个计划先不做。' }]
    const updates = results.filter((m) => m.toolName === 'update_plan').length
    const ran = runIndex >= 0 && !waitingForRun
    if (updates === 0) return call('update_plan', { step: 1, status: 'doing' })
    if (made && updates === 1) return call('update_plan', { step: 1, status: 'done' })
    if (made && updates === 2) return call('update_plan', { step: 2, status: 'doing' })
    if (ran && updates === 3)
      return call('update_plan', {
        step: 2,
        status: /用户跳过|过期/.test(runReply) ? 'skipped' : 'done',
      })
  }
  if (/更紧张/.test(ask)) {
    // 修改已有镜头：先找到生成图片节点，出修改方案，等用户选批准范围
    const found = results.find((m) => m.toolName === 'find_elements')
    if (!found) return call('find_elements', { node_type: 'plein/image' })
    const target = (
      JSON.parse(text(found) || '{}') as {
        elements?: Array<{ id: string; params?: { prompt?: string } }>
      }
    ).elements?.[0]
    if (!target) return [{ type: 'text', text: '【mock】画布上没有可以改的镜头。' }]
    const proposed = results.find((m) => m.toolName === 'propose_edit')
    if (!proposed)
      return call('propose_edit', {
        summary: '让画面更紧张',
        edits: [
          {
            id: target.id,
            params: { prompt: `${target.params?.prompt ?? ''}，手持晃动，压迫感更强` },
          },
        ],
      })
    const approval = (JSON.parse(text(proposed) || '{}') as { approval_id?: string }).approval_id
    if (!approval) return [{ type: 'text', text: `【mock】方案没出来：${text(proposed)}` }]
    const waits = results.filter((m) => m.toolName === 'await_approval')
    const waited = text(waits.at(-1))
    if (!waits.length || waited.includes('"pending"'))
      return call('await_approval', { approval_id: approval })
    if (waited.includes('"stale"'))
      return [{ type: 'text', text: '【mock】镜头在批准前变了，旧方案没有执行。' }]
    if (waited.includes('"applied"'))
      return [{ type: 'text', text: '【mock】方案已经按你选的范围执行。' }]
    return [{ type: 'text', text: '【mock】好的，这个方案先不做。' }]
  }
  if (/图|画/.test(ask) && !made)
    return call('create_node', {
      type: 'plein/image',
      name: '小满画的图',
      params: { prompt: ask },
    })
  const madeId = made && (JSON.parse(text(made) || '{}') as { id?: string }).id
  if (madeId && !results.some((m) => m.toolName === 'run_node'))
    return call('run_node', { id: madeId, wait_seconds: 10 })
  if (runApproval) {
    if (waitingForRun) return call('await_approval', { approval_id: runApproval })
    if (/用户跳过|过期/.test(runReply))
      return [{ type: 'text', text: '【mock】这次运行没有执行，已保留创建的节点。' }]
  }
  // 做完把用户的镜头带到结果上
  if (madeId && !results.some((m) => m.toolName === 'ui_focus'))
    return call('ui_focus', { ids: [madeId] })
  return [
    {
      type: 'text',
      text: made
        ? '【mock】好了，新建了一个生成图片节点并跑出了结果。'
        : `【mock】看过画布了：${ask}`,
    },
  ]
}

/** 按能力生成假结果：不联网、确定性，供开发和测试跑通整条链路 */
function fakeOutputs(req: ProviderRequest): ProviderOutput[] {
  switch (req.capability as Capability) {
    case 'text.chat': {
      const input = req.input as CapabilityInput<'text.chat'>
      if (req.model === 'agent-vision' && input.tools?.length) {
        const images = input.messages.flatMap((m) =>
          typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image'),
        )
        if (images.length)
          return [{ type: 'text', text: `【mock vision】实际收到 ${images.length} 张素材图片` }]
        const result = input.messages.findLast(
          (m) => m.role === 'tool' && m.toolName === 'view_media',
        )
        if (result)
          return [
            {
              type: 'text',
              text: `【mock vision】${typeof result.content === 'string' ? result.content : ''}`,
            },
          ]
        const assetId = /ASSET=([a-f0-9]{64})/.exec(lastUserText(input))?.[1]
        if (assetId)
          return [
            {
              type: 'tool_calls',
              calls: [{ id: 'vision-view', name: 'view_media', arguments: { asset_id: assetId } }],
            },
          ]
        return [{ type: 'text', text: '【mock vision】请提供 ASSET=素材ID' }]
      }
      if (req.model === 'agent' && input.tools?.length) return mockAgentStep(input)
      const text = lastUserText(input)
      if (input.jsonSchema && 'shots' in ((input.jsonSchema.properties as object) ?? {}))
        return [{ type: 'json', value: mockStoryboard(text) }]
      if (input.jsonSchema) return [{ type: 'json', value: { echo: text } }]
      // 角色与场景抽取：按模板要的 Markdown 结构回一份固定设定，让「生成设定卡」能跑通
      if (/^##\s*角色/m.test(text) && /^##\s*场景/m.test(text))
        return [{ type: 'text', text: MOCK_CAST }]
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
    case 'image.process': {
      const input = req.input as CapabilityInput<'image.process'>
      return [
        {
          type: 'file',
          kind: 'image',
          mime: 'image/png',
          name: 'mock-process.png',
          data: solidPng(256, 256, colorOf(input.operation + input.image.assetId)),
        },
      ]
    }
    case 'image.edit': {
      const input = req.input as CapabilityInput<'image.edit'>
      const [w, h] = (input.extra?.size as [number, number] | undefined) ?? [1024, 1024]
      return Array.from({ length: input.count ?? 1 }, (_, i) => ({
        type: 'file' as const,
        kind: 'image' as const,
        mime: 'image/png',
        name: `mock-edit-${i + 1}.png`,
        data: solidPng(w, h, colorOf(`${input.prompt}#${input.mask.assetId}#${i}`)),
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

/** PNG 的宽高（IHDR）；不是 PNG 时返回 null */
function pngSize(data: Uint8Array): [number, number] | null {
  if (data.length < 24 || data[0] !== 0x89 || data[1] !== 0x50) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return [view.getUint32(16), view.getUint32(20)]
}

async function withEditSize(req: ProviderRequest, ctx: ProviderContext): Promise<ProviderRequest> {
  const input = req.input as CapabilityInput<'image.edit'>
  const image = pngSize((await ctx.files.read(input.image)).data)
  const mask = pngSize((await ctx.files.read(input.mask)).data)
  if (image && mask && (image[0] !== mask[0] || image[1] !== mask[1]))
    throw new ProviderError('invalid_input', '模拟：蒙版和原图尺寸不一致')
  return { ...req, input: { ...input, extra: { ...input.extra, size: image ?? undefined } } }
}

/** 进行中的模拟异步任务 */
const pending = new Map<
  string,
  { startAt: number; readyAt: number; polls: number; queueMs: number; req: ProviderRequest }
>()
let seq = 0
/** 幂等键 → 远端任务：提交后没收到回应时按键查回来（模拟平台的按客户端标识查询） */
const byKey = new Map<string, string>()

export const mockProvider = defineProvider({
  id: 'plein/mock',
  title: 'Mock（开发测试用）',
  description: '不联网的假平台，按能力返回固定结果，用来在没有密钥时跑通工作流',
  settings: z.object({
    latencyMs: z.number().int().min(0).max(60_000).default(0).meta({ title: '模拟耗时（毫秒）' }),
    queueMs: z.number().int().min(0).max(60_000).default(0).meta({ title: '其中平台排队（毫秒）' }),
    failWith: z
      .enum(['none', 'auth', 'rate_limit', 'content_policy'])
      .default('none')
      .meta({ title: '模拟错误' }),
  }),
  secrets: [
    { name: 'MOCK_API_KEY', title: 'API Key', help: 'mock 不校验密钥，用来演示密钥的存储方式' },
  ],
  models: [
    // 排第一的是默认对话模型：开发时开箱就能驱动内置智能体，不带工具时和普通对话一样
    { id: 'agent', title: 'Mock 智能体', capabilities: ['text.chat'], features: ['tools'] },
    {
      id: 'agent-vision',
      title: 'Mock 视觉智能体',
      capabilities: ['text.chat'],
      features: ['tools', 'vision'],
    },
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
      id: 'image-process',
      title: 'Mock 图片精修',
      capabilities: ['image.process'],
      limits: { imageOperations: ['upscale', 'outpaint', 'cutout'] },
    },
    {
      id: 'image-edit',
      title: 'Mock 局部重绘',
      capabilities: ['image.edit'],
      limits: { count: { max: 4 } },
    },
    {
      id: 'video',
      title: 'Mock 视频',
      capabilities: ['video.generate'],
      limits: {
        referenceMedia: { video: 10, audio: 10 },
        resolutions: ['480p', '720p', '1080p'],
        duration: { min: 2, max: 10 },
        seed: false,
      },
    },
    {
      id: 'audio',
      title: 'Mock 音频',
      capabilities: ['audio.speech', 'audio.music', 'audio.sfx', 'audio.transcribe'],
      voices: [
        { id: 'mock-female', title: 'Mock 女声', gender: 'female' },
        { id: 'mock-male', title: 'Mock 男声', gender: 'male' },
        { id: 'mock-uncle', title: 'Mock 大叔', gender: 'male', age: 'mature' },
      ],
    },
  ],
  async test(ctx) {
    if (ctx.settings.failWith === 'auth') throw new ProviderError('auth', '模拟：密钥无效')
  },
  async submit(req, ctx) {
    const fail = ctx.settings.failWith
    if (fail !== 'none') throw new ProviderError(fail, `模拟错误：${fail}`)
    if (req.model === 'agent-vision' && req.capability === 'text.chat') {
      for (const message of (req.input as CapabilityInput<'text.chat'>).messages)
        if (Array.isArray(message.content))
          for (const part of message.content)
            if (part.type === 'image') {
              const file = await ctx.files.read(part.image)
              if (!file.data.length || !file.mime.startsWith('image/'))
                throw new ProviderError('invalid_input', 'mock vision 图片不可读')
            }
    }
    // 局部重绘：像真平台一样校验蒙版和原图同尺寸，结果按原图尺寸出
    if (req.capability === 'image.edit') req = await withEditSize(req, ctx)
    if (ctx.settings.latencyMs === 0) {
      const outputs = fakeOutputs(req)
      // 同步出结果也登记一个已完成的任务，按幂等键能查到
      if (ctx.idempotencyKey) {
        const remoteId = `mock-${++seq}`
        const now = Date.now()
        pending.set(remoteId, { startAt: now, readyAt: now, polls: 0, queueMs: 0, req })
        byKey.set(ctx.idempotencyKey, remoteId)
      }
      // 流式：文本分几段回调，界面能看到逐字出现
      for (const o of outputs)
        if (o.type === 'text' && ctx.stream)
          for (const piece of o.text.match(/[\s\S]{1,6}/g) ?? []) ctx.stream({ text: piece })
      return { state: 'succeeded', outputs }
    }
    const remoteId = `mock-${++seq}`
    pending.set(remoteId, {
      startAt: Date.now(),
      polls: 0,
      queueMs: ctx.settings.queueMs,
      readyAt: Date.now() + ctx.settings.latencyMs,
      req,
    })
    if (ctx.idempotencyKey) byKey.set(ctx.idempotencyKey, remoteId)
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
    if (left > 0) {
      // 第一次查询时（和设置的排队时长内）还在平台排队，之后生成，进度按时间推进
      const total = job.readyAt - job.startAt
      const queued = job.polls++ === 0 || Date.now() - job.startAt < job.queueMs
      return queued
        ? {
            state: 'pending',
            remote: 'queued',
            pollAfterMs: Math.min(left, Math.ceil(total / 3), 500),
          }
        : {
            state: 'pending',
            remote: 'running',
            progress: Math.min(0.95, (total - left) / total),
            pollAfterMs: Math.min(left, Math.ceil(total / 3), 500),
          }
    }
    pending.delete(remoteId)
    return { state: 'succeeded', outputs: fakeOutputs(job.req) }
  },
  async cancel(remoteId) {
    pending.delete(remoteId)
  },
  async lookup(key) {
    const remoteId = byKey.get(key)
    return remoteId ? { remoteId } : null
  },
  // 先报训练中，查一次状态就好；样本只读一下，确认宿主把文件交了过来
  voiceClone: {
    voiceId: 'generated',
    hint: '模拟复刻，不调用真实平台',
    async clone({ sample }, ctx) {
      const asset = await ctx.files.read(sample)
      if (!asset.mime.startsWith('audio/'))
        throw new ProviderError('invalid_input', '复刻样本须为音频')
      return { status: 'training' }
    },
    async status() {
      return { status: 'ready' }
    },
  },
})

/** 演示插件能力：在选区旁边贴一张便签，写上选中了什么（只经 ctx.call 改画布） */
const mockSticky = definePluginCapability({
  id: 'plein/mock-sticky',
  title: '贴一张便签（Mock）',
  description: '在选中的元素旁边贴一张 Markdown 便签；不给 text 时写上选中元素的名字。',
  effect: 'edit',
  palette: 'selection',
  input: z.object({ text: z.string().max(2000).optional().describe('便签内容') }),
  async run(ctx, { text }) {
    const [first] = ctx.selection
    if (!first) throw new Error('先选中一个元素')
    const names: string[] = []
    for (const id of ctx.selection.slice(0, 20)) {
      const el = (await ctx.call('get_element', { id })) as { name?: string; kind?: string }
      names.push(el.name ?? el.kind ?? id)
    }
    const made = (await ctx.call('create_element', {
      kind: 'markdown',
      name: '便签',
      text: text ?? `选中了：${names.join('、')}`,
      near: first,
    })) as { id: string }
    return { id: made.id, note: `已在「${names[0]}」旁边贴了便签` }
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
      contributes: { providers: ['plein/mock'], capabilities: ['plein/mock-sticky'] },
      permissions: { secrets: ['MOCK_API_KEY'], assets: 'read' },
    },
  }),
  { providers: [mockProvider], capabilities: [mockSticky] },
)

import {
  type AssetRef,
  type CapabilityInput,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  type ProviderContext,
  ProviderError,
  type ProviderErrorCode,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { chatMessages, imageDataUrl, type Method, redact, retryableFor, send } from '../shared/http'
import { sizeByLongEdge, tierEdge } from '../size'

const settings = z.object({
  region: z.enum(['cn', 'global']).default('cn').meta({ title: 'API 地区' }),
  voice: z.string().min(1).default('male-qn-qingse').meta({ title: '默认音色 ID' }),
})
type Context = ProviderContext<z.output<typeof settings>>
const responseSchema = z
  .object({
    base_resp: z
      .object({ status_code: z.coerce.number().optional(), status_msg: z.string().optional() })
      .optional(),
    error: z.object({ type: z.string().optional(), message: z.string().optional() }).optional(),
    data: z.preprocess(
      (value) => (Array.isArray(value) ? undefined : value),
      z
        .object({ audio: z.string().optional(), image_urls: z.array(z.string().url()).optional() })
        .optional(),
    ),
    task_id: z.union([z.string(), z.number()]).optional(),
    task: z
      .object({
        id: z.union([z.string(), z.number()]),
        status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
        content: z.object({ url: z.string().url().optional() }).optional(),
        error: z.object({ type: z.string().optional(), message: z.string().optional() }).nullish(),
        duration: z.number().optional(),
      })
      .optional(),
    choices: z
      .array(
        z.object({
          finish_reason: z.string().nullish(),
          message: z.object({ content: z.string().nullish() }),
        }),
      )
      .optional(),
    usage: z
      .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
      .optional(),
    extra_info: z
      .object({ usage_characters: z.number().optional(), audio_length: z.number().optional() })
      .optional(),
    input_sensitive: z.boolean().optional(),
    output_sensitive: z.boolean().optional(),
  })
  .passthrough()

function errorCode(code: number | string): ProviderErrorCode {
  if (Number(code) === 410) return 'unavailable'
  if ([401, 403, 1004, 2049].includes(Number(code)) || /auth|permission/i.test(String(code)))
    return 'auth'
  if ([402, 1008].includes(Number(code)) || /balance|quota/i.test(String(code))) return 'quota'
  if ([429, 1002].includes(Number(code)) || /rate_limit/i.test(String(code))) return 'rate_limit'
  if ([1026, 1027, 1043].includes(Number(code)) || /sensitive|content_policy/i.test(String(code)))
    return 'content_policy'
  if ([408, 504, 1001].includes(Number(code))) return 'timeout'
  if ((Number(code) >= 500 && Number(code) < 600) || [1000, 1013].includes(Number(code)))
    return 'unavailable'
  if ([400, 422, 2013].includes(Number(code)) || /bad_request|invalid/i.test(String(code)))
    return 'invalid_input'
  return 'unknown'
}

async function request(
  ctx: Context,
  path: string,
  body?: unknown,
  method: Method = body ? 'POST' : 'GET',
) {
  const key = ctx.secret('MINIMAX_API_KEY')?.trim()
  if (!key) throw new ProviderError('auth', '请填写 MiniMax API Key')
  const payload = body === undefined ? undefined : JSON.stringify(body)
  if (payload && Buffer.byteLength(payload) > 64 * 1024 * 1024)
    throw new ProviderError('invalid_input', 'MiniMax 请求体超过 64 MB')
  const res = await send(
    ctx,
    `${ctx.settings.region === 'cn' ? 'https://api.minimax.cn' : 'https://api.minimax.io'}${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: payload,
    },
    {
      cancelled: 'MiniMax 请求已取消',
      network: 'MiniMax 网络请求失败；生成提交状态可能未知，请勿自动重试',
    },
  )
  const parsed = responseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) {
    const code = res.ok ? 'unknown' : errorCode(res.status)
    // 查询接口遇到网关错误页（502/503 等非 JSON）可以重试；提交接口一律不重试
    throw new ProviderError(code, `MiniMax 返回无效响应（HTTP ${res.status}）`, {
      retryable: retryableFor(method, code),
    })
  }
  const data = parsed.data
  if (!res.ok || data.error || (data.base_resp?.status_code ?? 0) !== 0) {
    const code = data.error?.type ?? data.base_resp?.status_code ?? res.status
    const message = redact(
      data.error?.message ?? data.base_resp?.status_msg ?? `HTTP ${res.status}`,
      [key],
    )
    const normalized = errorCode(code) === 'unknown' ? errorCode(res.status) : errorCode(code)
    throw new ProviderError(normalized, `MiniMax：${message}`, {
      retryable: retryableFor(method, normalized),
    })
  }
  return data
}

function imageData(ctx: Context, ref: AssetRef, maxMb = 30) {
  const message = `MiniMax 图片格式不支持或超过 ${maxMb} MB`
  return imageDataUrl(ctx, ref, {
    notImage: 'MiniMax 参考素材必须是图片',
    accept: (mime) =>
      ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(mime),
    badMime: message,
    maxBytes: maxMb * 1024 * 1024,
    tooLarge: message,
  })
}

function required(value: string, max: number, label: string) {
  if (!value.trim() || value.length > max)
    throw new ProviderError('invalid_input', `${label}须为 1–${max} 字符`)
}

function id(value: string) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new ProviderError('invalid_input', '无效 MiniMax task ID')
  return value
}

export const minimaxProvider = defineProvider({
  id: 'minimax/api',
  title: 'MiniMax',
  description: '对话、图片、H3 音画视频、语音和音乐；生成使用按量 API Key',
  docsUrl: 'https://platform.minimax.cn/docs/api-reference/api-overview',
  settings,
  secrets: [
    {
      name: 'MINIMAX_API_KEY',
      title: 'API Key',
      required: true,
      help: '密钥须与 API 地区一致；H3 使用按量接口',
    },
  ],
  models: [
    { id: 'MiniMax-M3', title: 'MiniMax M3', capabilities: ['text.chat'] },
    { id: 'MiniMax-M2.7', title: 'MiniMax M2.7（纯文本）', capabilities: ['text.chat'] },
    {
      id: 'image-01',
      title: 'image-01',
      capabilities: ['image.generate' as const],
      limits: {
        aspectRatios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
        resolutions: ['1K', '2K'],
        count: { max: 9 },
        references: { max: 1 },
      },
    },
    {
      id: 'image-01-live',
      title: 'image-01-live',
      capabilities: ['image.generate' as const],
      limits: {
        aspectRatios: ['16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
        count: { max: 9 },
        references: { max: 1 },
      },
    },
    {
      id: 'MiniMax-H3',
      title: 'MiniMax-H3',
      capabilities: ['video.generate' as const],
      limits: {
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
        resolutions: ['768P', '2K'],
        duration: { min: 4, max: 15 },
        seed: false,
        audio: false,
        references: { max: 9 },
      },
    },
    {
      id: 'MiniMax-H3-Max',
      title: 'MiniMax-H3-Max',
      capabilities: ['video.generate' as const],
      limits: {
        aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
        resolutions: ['480P', '768P'],
        duration: { min: 5, max: 15 },
        seed: false,
        audio: false,
        references: { max: 9 },
      },
    },
    ...['speech-2.8-hd', 'speech-2.8-turbo'].map((id) => ({
      id,
      title: id,
      capabilities: ['audio.speech' as const],
      limits: { speed: { min: 0.5, max: 2 }, instruction: false },
      options: z.object({
        emotion: z
          .enum(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'])
          .optional()
          .meta({
            title: '情绪',
            labels: {
              happy: '高兴',
              sad: '悲伤',
              angry: '愤怒',
              fearful: '害怕',
              disgusted: '厌恶',
              surprised: '惊讶',
              calm: '平静',
            },
          }),
      }),
    })),
    {
      id: 'music-3.0',
      title: 'Music 3.0',
      capabilities: ['audio.music'],
      limits: { duration: false },
    },
  ],
  limits: { concurrency: 2 },
  async test(ctx) {
    await request(ctx, '/v1/models')
  },
  async submit(req, ctx) {
    if (
      !minimaxProvider.models.some(
        (m) => m.id === req.model && m.capabilities.includes(req.capability),
      )
    )
      throw new ProviderError('invalid_input', 'MiniMax 模型与能力不匹配')
    switch (req.capability) {
      case 'text.chat': {
        const input = req.input as CapabilityInput<'text.chat'>
        if (input.jsonSchema)
          throw new ProviderError('invalid_input', 'MiniMax 此适配器不支持 JSON Schema 输出')
        const messages = await chatMessages(input.messages, (ref) => {
          if (req.model !== 'MiniMax-M3')
            throw new ProviderError('invalid_input', 'M2.7 只支持纯文本，请使用 M3 处理图片')
          return imageData(ctx, ref)
        })
        const result = await request(ctx, '/v1/chat/completions', {
          model: req.model,
          messages,
          stream: false,
          reasoning_split: true,
          temperature: input.temperature,
          max_completion_tokens: input.maxTokens,
        })
        if (
          result.input_sensitive ||
          result.output_sensitive ||
          result.choices?.[0]?.finish_reason === 'content_filter'
        )
          throw new ProviderError('content_policy', 'MiniMax 内容审核未通过')
        const text = result.choices?.[0]?.message.content
        if (!text) throw new ProviderError('unknown', 'MiniMax 响应缺少文本', { retryable: false })
        return {
          state: 'succeeded',
          outputs: [{ type: 'text', text }],
          usage: {
            inputTokens: result.usage?.prompt_tokens,
            outputTokens: result.usage?.completion_tokens,
          },
        }
      }
      case 'image.generate': {
        const input = req.input as CapabilityInput<'image.generate'>
        required(input.prompt, 1500, '图片提示词')
        if ((input.references?.length ?? 0) > 1)
          throw new ProviderError('invalid_input', 'MiniMax 图片仅支持一张人物参考图')
        if (input.negativePrompt)
          throw new ProviderError('invalid_input', 'MiniMax 图片不支持 negativePrompt')
        const n = input.count ?? 1
        if (!Number.isInteger(n) || n < 1 || n > 9)
          throw new ProviderError('invalid_input', 'MiniMax 图片数量须为 1–9')
        const reference = input.references?.[0]
        // 分辨率档位按长边换算宽高（image-01 宽高 512–2048、8 的倍数），优先于 aspect_ratio
        let { width, height } = input
        if (input.resolution !== undefined && width === undefined && height === undefined) {
          const edge = tierEdge(input.resolution)
          if (req.model !== 'image-01' || !edge || edge > 2048)
            throw new ProviderError('invalid_input', '所选 MiniMax 图片模型不支持该分辨率')
          const aspect = input.extra?.aspectRatio
          ;({ width, height } = sizeByLongEdge(typeof aspect === 'string' ? aspect : '1:1', edge))
          width = Math.max(512, width)
          height = Math.max(512, height)
        }
        const result = await request(ctx, '/v1/image_generation', {
          model: req.model,
          prompt: input.prompt,
          n,
          seed: input.seed,
          aspect_ratio: width ? undefined : (input.extra?.aspectRatio ?? '1:1'),
          width,
          height,
          response_format: 'url',
          subject_reference: reference
            ? [{ type: 'character', image_file: await imageData(ctx, reference, 10) }]
            : undefined,
        })
        const urls = result.data?.image_urls
        if (!urls?.length)
          throw new ProviderError('unknown', 'MiniMax 响应缺少图片', { retryable: false })
        if (urls.length < n)
          ctx.log('MiniMax 仅生成部分图片，不自动重试', { requested: n, received: urls.length })
        return {
          state: 'succeeded',
          outputs: urls.map((url) => ({ type: 'file', kind: 'image', mime: 'image/jpeg', url })),
          usage: { images: urls.length },
        }
      }
      case 'video.generate': {
        const input = req.input as CapabilityInput<'video.generate'>
        required(input.prompt, 7000, '视频提示词')
        const max = req.model === 'MiniMax-H3-Max'
        const duration = input.duration ?? 5
        const resolution = input.resolution ?? (max ? '768P' : '2K')
        if (!Number.isInteger(duration) || duration < (max ? 5 : 4) || duration > 15)
          throw new ProviderError(
            'invalid_input',
            `H3${max ? '-Max' : ''} 时长须为 ${max ? 5 : 4}–15 整数秒`,
          )
        if (!(max ? ['480P', '768P'] : ['768P', '2K']).includes(resolution))
          throw new ProviderError('invalid_input', '所选 H3 模型不支持该分辨率')
        const frames = Boolean(input.firstFrame || input.lastFrame)
        if (frames && input.references?.length)
          throw new ProviderError('invalid_input', 'H3 首尾帧和参考图不能混用')
        if ((input.references?.length ?? 0) > 9)
          throw new ProviderError('invalid_input', 'H3 最多支持 9 张参考图')
        if (input.seed !== undefined) throw new ProviderError('invalid_input', 'H3 V2 不支持 seed')
        const content: unknown[] = [{ type: 'text', text: input.prompt }]
        for (const [role, refs] of [
          ['first_frame', input.firstFrame ? [input.firstFrame] : []],
          ['last_frame', input.lastFrame ? [input.lastFrame] : []],
          ['reference_image', input.references ?? []],
        ] as const) {
          for (const ref of refs)
            content.push({ type: 'image_url', image_url: { url: await imageData(ctx, ref) }, role })
        }
        const result = await request(ctx, '/v2/video_generation', {
          model: req.model,
          content,
          duration,
          resolution,
          ratio: frames ? 'adaptive' : (input.aspectRatio ?? '16:9'),
        })
        if (!result.task_id)
          throw new ProviderError(
            'unknown',
            'MiniMax 提交响应缺少 task_id；提交状态未知，请勿重新生成',
            { retryable: false },
          )
        return { state: 'pending', remoteId: id(String(result.task_id)), pollAfterMs: 10_000 }
      }
      case 'audio.speech': {
        const input = req.input as CapabilityInput<'audio.speech'>
        required(input.text, 9999, '台词')
        if (input.instruction)
          throw new ProviderError(
            'invalid_input',
            'MiniMax 不支持自由语气指令；请通过 extra.emotion 指定官方情绪值，或使用豆包/千问配音',
          )
        const speed = input.speed ?? 1
        if (speed < 0.5 || speed > 2)
          throw new ProviderError('invalid_input', 'MiniMax 语速须为 0.5–2')
        const result = await request(ctx, '/v1/t2a_v2', {
          model: req.model,
          text: input.text,
          stream: false,
          output_format: 'hex',
          voice_setting: {
            voice_id: input.voice || ctx.settings.voice,
            speed,
            vol: 1,
            pitch: 0,
            emotion: input.extra?.emotion,
          },
          audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
        })
        const audio = result.data?.audio
        if (!audio || !/^(?:[a-f\d]{2})+$/i.test(audio))
          throw new ProviderError('unknown', 'MiniMax 响应缺少有效 hex 音频', { retryable: false })
        return {
          state: 'succeeded',
          outputs: [
            {
              type: 'file',
              kind: 'audio',
              mime: 'audio/mpeg',
              data: new Uint8Array(Buffer.from(audio, 'hex')),
            },
          ],
          usage: {
            characters: result.extra_info?.usage_characters,
            seconds:
              result.extra_info?.audio_length === undefined
                ? undefined
                : result.extra_info.audio_length / 1000,
          },
        }
      }
      case 'audio.music': {
        const input = req.input as CapabilityInput<'audio.music'>
        required(input.prompt, 2000, '音乐描述')
        if (input.duration) ctx.log('MiniMax Music 时长由模型决定，duration 不作为接口参数')
        const result = await request(ctx, '/v1/music_generation', {
          model: req.model,
          prompt: input.prompt,
          lyrics: '',
          is_instrumental: true,
          stream: false,
          output_format: 'hex',
          audio_setting: { format: 'mp3', sample_rate: 44100, bitrate: 256000 },
        })
        const audio = result.data?.audio
        if (!audio || !/^(?:[a-f\d]{2})+$/i.test(audio))
          throw new ProviderError('unknown', 'MiniMax 响应缺少有效 hex 音乐', { retryable: false })
        return {
          state: 'succeeded',
          outputs: [
            {
              type: 'file',
              kind: 'audio',
              mime: 'audio/mpeg',
              data: new Uint8Array(Buffer.from(audio, 'hex')),
            },
          ],
        }
      }
      default:
        throw new ProviderError('invalid_input', `MiniMax 不支持 ${req.capability}`)
    }
  },
  async poll(remoteId, ctx) {
    const result = await request(ctx, `/v2/query/video_generation/${id(remoteId)}`)
    const task = result.task
    if (!task || String(task.id) !== remoteId)
      throw new ProviderError('unknown', 'MiniMax 查询未返回匹配的任务')
    if (task.status === 'queued' || task.status === 'running')
      return { state: 'pending', pollAfterMs: 10_000 }
    if (task.status === 'failed' || task.status === 'cancelled')
      return {
        state: 'failed',
        error: {
          code: task.status === 'cancelled' ? 'cancelled' : errorCode(task.error?.type ?? ''),
          message: task.error?.message ?? `MiniMax 任务 ${task.status}`,
          retryable: false,
        },
      }
    if (!task.content?.url) throw new ProviderError('unknown', 'MiniMax 成功任务缺少视频 URL')
    return {
      state: 'succeeded',
      outputs: [{ type: 'file', kind: 'video', mime: 'video/mp4', url: task.content.url }],
      usage: { seconds: task.duration },
    }
  },
  async cancel(remoteId, ctx) {
    const result = await request(ctx, `/v2/query/video_generation/${id(remoteId)}`)
    // DELETE 也会删除已完成记录，因此仅对排队状态发取消请求。
    if (result.task?.status === 'queued')
      await request(ctx, `/v2/video_generation/${id(remoteId)}`, undefined, 'DELETE')
  },
})

export const minimaxPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'minimax/api',
      version: '0.1.0',
      name: 'MiniMax',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['minimax/api'] },
      permissions: {
        network: [
          'api.minimax.cn',
          'api.minimax.io',
          '*.hailuoai.com',
          '*.minimax.cn',
          '*.minimax.io',
          '*.minimax.chat',
          '*.minimaxi.com',
          'hailuo-image-algeng-data.oss-cn-wulanchabu.aliyuncs.com',
          'algeng-video-infer.oss-cn-shanghai.aliyuncs.com',
        ],
        secrets: ['MINIMAX_API_KEY'],
        assets: 'read',
      },
    },
  }),
  { providers: [minimaxProvider] },
)

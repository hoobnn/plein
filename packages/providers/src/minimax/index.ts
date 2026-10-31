import { downloadVoicePreview } from '../shared/voice-preview'
import { videoReferenceProblem, videoReferencePrompt } from '@plein/plugin-sdk'
import { videoReferences } from '../shared/video-references'
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
import {
  chatMessages,
  imageDataUrl,
  type Method,
  readJson,
  redact,
  withRetry,
  send,
} from '../shared/http'
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
    // 对话返回布尔值，声音复刻返回 { type }，0 为正常
    input_sensitive: z
      .union([z.boolean(), z.object({ type: z.number() }).passthrough()])
      .optional(),
    output_sensitive: z
      .union([z.boolean(), z.object({ type: z.number() }).passthrough()])
      .optional(),
    file: z
      .object({ file_id: z.union([z.string(), z.number()]) })
      .passthrough()
      .optional(),
  })
  .passthrough()

function errorCode(code: number | string): ProviderErrorCode {
  if (Number(code) === 410) return 'unavailable'
  if ([401, 403, 1004, 2038, 2049].includes(Number(code)) || /auth|permission/i.test(String(code)))
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

const sensitive = (value: boolean | { type: number } | undefined) =>
  typeof value === 'object' ? value.type !== 0 : value === true

/** body 是 FormData 时按 multipart 上传，Content-Type 交给 fetch 带上 boundary */
async function request(
  ctx: Context,
  path: string,
  body?: unknown,
  method: Method = body ? 'POST' : 'GET',
) {
  const key = ctx.secret('MINIMAX_API_KEY')?.trim()
  if (!key) throw new ProviderError('auth', '请填写 MiniMax API Key')
  const form = body instanceof FormData ? body : undefined
  const payload = form ?? (body === undefined ? undefined : JSON.stringify(body))
  if (typeof payload === 'string' && Buffer.byteLength(payload) > 64 * 1024 * 1024)
    throw new ProviderError('invalid_input', 'MiniMax 请求体超过 64 MB')
  const messages = {
    cancelled: 'MiniMax 请求已取消',
    network: 'MiniMax 网络请求失败；生成提交状态可能未知，请勿自动重试',
  }
  const res = await send(
    ctx,
    `${ctx.settings.region === 'cn' ? 'https://api.minimax.cn' : 'https://api.minimax.io'}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(form ? {} : { 'Content-Type': 'application/json' }),
      },
      body: payload,
    },
    messages,
  )
  const parsed = responseSchema.safeParse(await readJson(ctx, res, method, messages))
  if (!parsed.success) {
    const code = res.ok ? 'unknown' : errorCode(res.status)
    // 查询接口遇到网关错误页（502/503 等非 JSON）可以重试；提交接口一律不重试
    throw withRetry(
      new ProviderError(code, `MiniMax 返回无效响应（HTTP ${res.status}）`),
      method,
      res.status,
    )
  }
  const data = parsed.data
  if (!res.ok || data.error || (data.base_resp?.status_code ?? 0) !== 0) {
    const code = data.error?.type ?? data.base_resp?.status_code ?? res.status
    const message = redact(
      data.error?.message ?? data.base_resp?.status_msg ?? `HTTP ${res.status}`,
      [key],
    )
    const normalized = errorCode(code) === 'unknown' ? errorCode(res.status) : errorCode(code)
    throw withRetry(new ProviderError(normalized, `MiniMax：${message}`), method, res.status)
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

/** 复刻样本可接受的格式与上传时的扩展名 */
const CLONE_FORMATS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
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

async function clonePreview(value: unknown, ctx: Context) {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return undefined
    return await downloadVoicePreview(url.toString(), ctx)
  } catch {
    ctx.log('音色已创建，试听暂未保存；请在平台核查，避免重复创建')
    return undefined
  }
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
    { id: 'MiniMax-M3.1-Flash', title: 'MiniMax M3.1 Flash', capabilities: ['text.chat'] },
    {
      id: 'MiniMax-M2.7',
      title: 'MiniMax M2.7（纯文本）',
      description: '已停止向新用户开放；按量付费存量用户可调用至 2026-11-18，请提前迁移至 M3.1 Flash',
      deprecated: true,
      capabilities: ['text.chat'],
    },
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
    ...['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'].map((id) => ({
      id,
      title: id,
      capabilities: ['video.generate' as const],
      limits: {
        aspectRatios: ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        resolutions:
          id === 'MiniMax-H3'
            ? ['768P', '2K']
            : id === 'MiniMax-H3-Highspeed'
              ? ['768P']
              : ['480P', '768P'],
        duration: { min: id === 'MiniMax-H3-Max' ? 5 : 4, max: 15 },
        seed: false,
        audio: false,
        references: { max: 9 },
        referenceMedia: { video: 3, audio: 3, audioOnly: true },
      },
    })),
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
      description: '官方已停止向新用户开放；历史付费用户可继续使用现有 API',
      deprecated: true,
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
        // 未使用平台的严格结构化参数：把 Schema 作为指令发送，返回后仍须校验。
        const schema = input.jsonSchema
          ? z.fromJSONSchema(input.jsonSchema as Parameters<typeof z.fromJSONSchema>[0])
          : null
        const messages = await chatMessages(input.messages, (ref) => {
          if (req.model !== 'MiniMax-M3')
            throw new ProviderError('invalid_input', 'M2.7 只支持纯文本，请使用 M3 处理图片')
          return imageData(ctx, ref)
        })
        if (schema)
          messages.unshift({
            role: 'system',
            content: `Return only valid JSON matching this schema, without Markdown or explanation: ${JSON.stringify(input.jsonSchema)}`,
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
          sensitive(result.input_sensitive) ||
          sensitive(result.output_sensitive) ||
          result.choices?.[0]?.finish_reason === 'content_filter'
        )
          throw new ProviderError('content_policy', 'MiniMax 内容审核未通过')
        const text = result.choices?.[0]?.message.content
        if (!text) throw new ProviderError('unknown', 'MiniMax 响应缺少文本', { retryable: false })
        let value: unknown
        if (schema) {
          if (result.choices?.[0]?.finish_reason === 'length')
            throw new ProviderError('unknown', 'MiniMax 结构化输出被截断，请增加输出长度', {
              retryable: false,
            })
          try {
            value = schema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')))
          } catch {
            throw new ProviderError(
              'unknown',
              'MiniMax 返回的 JSON 不符合要求，请修改要求或换模型',
              {
                retryable: false,
              },
            )
          }
        }
        return {
          state: 'succeeded',
          outputs: schema ? [{ type: 'json', value }] : [{ type: 'text', text }],
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
        const resolution = input.resolution ?? (req.model === 'MiniMax-H3' ? '2K' : '768P')
        if (!Number.isInteger(duration) || duration < (max ? 5 : 4) || duration > 15)
          throw new ProviderError(
            'invalid_input',
            `H3${max ? '-Max' : ''} 时长须为 ${max ? 5 : 4}–15 整数秒`,
          )
        if (
          !(
            req.model === 'MiniMax-H3'
              ? ['768P', '2K']
              : req.model === 'MiniMax-H3-Highspeed'
                ? ['768P']
                : ['480P', '768P']
          ).includes(resolution)
        )
          throw new ProviderError('invalid_input', '所选 H3 模型不支持该分辨率')
        const frames = Boolean(input.firstFrame || input.lastFrame)
        if (frames && input.references?.length)
          throw new ProviderError('invalid_input', 'H3 首尾帧和参考图不能混用')
        if ((input.references ?? []).filter((ref) => ref.kind === 'image').length > 9)
          throw new ProviderError('invalid_input', 'H3 最多支持 9 张参考图')
        if (input.seed !== undefined) throw new ProviderError('invalid_input', 'H3 V2 不支持 seed')
        const ratio = frames
          ? 'adaptive'
          : input.aspectRatio === 'auto'
            ? 'adaptive'
            : (input.aspectRatio ?? '16:9')
        if (!['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(ratio))
          throw new ProviderError('invalid_input', 'H3 不支持该宽高比')
        if (
          ratio === 'adaptive' &&
          (!input.references?.length || req.model === 'MiniMax-H3-Lite') &&
          !frames
        )
          throw new ProviderError('invalid_input', '文生视频和 H3-Lite 参考模式需要选择具体画幅')
        const counts = { image: 0, video: 0, audio: 0 }
        for (const ref of input.references ?? [])
          if (ref.kind === 'image' || ref.kind === 'video' || ref.kind === 'audio')
            counts[ref.kind]++
        const referenceProblem = videoReferenceProblem(input.prompt, counts)
        if (referenceProblem) throw new ProviderError('invalid_input', referenceProblem)
        const content: unknown[] = [
          { type: 'text', text: videoReferencePrompt(input.prompt, 'minimax') },
        ]
        for (const [role, refs] of [
          ['first_frame', input.firstFrame ? [input.firstFrame] : []],
          ['last_frame', input.lastFrame ? [input.lastFrame] : []],
        ] as const) {
          for (const ref of refs) {
            if (ref.kind !== 'image') throw new ProviderError('invalid_input', '首尾帧须为图片资产')
            const [frame] = await videoReferences([ref], ctx, {
              image: 1,
              video: 0,
              audio: 0,
              duration: 15,
              platform: 'minimax',
            })
            content.push({ ...frame, role })
          }
        }
        if (input.references?.length)
          content.push(
            ...(await videoReferences(input.references, ctx, {
              image: 9,
              video: 3,
              audio: 3,
              duration: 15,
              allowAudioOnly: true,
              platform: 'minimax',
            })),
          )
        const result = await request(ctx, '/v2/video_generation', {
          model: req.model,
          content,
          duration,
          resolution,
          ratio,
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
      return { state: 'pending', pollAfterMs: 10_000, remote: task.status }
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
    if (!result.task || String(result.task.id) !== remoteId)
      throw new ProviderError('unknown', 'MiniMax 查询未返回匹配的任务，未执行取消')
    // DELETE 也会删除已完成记录，因此仅对排队状态发取消请求。
    if (result.task?.status === 'queued')
      await request(ctx, `/v2/video_generation/${id(remoteId)}`, undefined, 'DELETE')
  },
  // 复刻是同步接口：上传样本拿 file_id，再提交复刻，成功即可用
  voiceClone: {
    voiceId: 'generated',
    promptSample: true,
    previewModel: 'speech-2.8-hd',
    hint: '需要先在 MiniMax 完成实名认证。样本 10 秒至 5 分钟、单人清晰，MP3 / M4A / WAV，20 MB 以内；复刻出的音色 7 天内没用于正式合成会被平台删除',
    async clone(
      {
        voiceId,
        sample,
        noiseReduction = false,
        volumeNormalization = false,
        previewText,
        promptSample,
        promptText,
      },
      ctx,
    ) {
      const asset = await ctx.files.read(sample)
      const ext = CLONE_FORMATS[asset.mime.toLowerCase()]
      if (!ext) throw new ProviderError('invalid_input', '复刻样本须为 MP3、M4A 或 WAV 音频')
      if (!asset.data.length || asset.data.length > 20 * 1024 * 1024)
        throw new ProviderError('invalid_input', '复刻样本须在 20 MB 以内')
      if (
        asset.duration !== undefined &&
        (!Number.isFinite(asset.duration) || asset.duration < 10 || asset.duration > 300)
      )
        throw new ProviderError('invalid_input', '复刻样本须为 10 秒至 5 分钟')
      if (!/^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/.test(voiceId))
        throw new ProviderError(
          'invalid_input',
          '音色 ID 须为 8–256 位，字母开头，末尾为字母或数字',
        )
      if (previewText && previewText.length > 1000)
        throw new ProviderError('invalid_input', '试听文本须在 1000 字以内')
      if (!!promptSample !== !!promptText?.trim())
        throw new ProviderError('invalid_input', '增强参考音频和对应文字须同时提供')
      let promptAsset: Awaited<ReturnType<typeof ctx.files.read>> | undefined
      if (promptSample) {
        promptAsset = await ctx.files.read(promptSample)
        if (
          !CLONE_FORMATS[promptAsset.mime.toLowerCase()] ||
          !promptAsset.data.length ||
          promptAsset.data.length > 20 * 1024 * 1024 ||
          (promptAsset.duration !== undefined &&
            (!Number.isFinite(promptAsset.duration) ||
              promptAsset.duration <= 0 ||
              promptAsset.duration >= 8))
        )
          throw new ProviderError(
            'invalid_input',
            '增强参考须为小于 8 秒的 MP3、M4A 或 WAV，20 MB 以内',
          )
      }
      const form = new FormData()
      form.set('purpose', 'voice_clone')
      form.set('file', new Blob([Buffer.from(asset.data)], { type: asset.mime }), `sample.${ext}`)
      const uploaded = await request(ctx, '/v1/files/upload', form)
      const fileId = uploaded.file?.file_id
      // file_id 是 int64，超出 JS 安全整数时 JSON 解析已丢精度，不能拿去提交
      if (fileId === undefined || (typeof fileId === 'number' && !Number.isSafeInteger(fileId)))
        throw new ProviderError('unknown', 'MiniMax 上传样本后没有返回可用的文件 ID')
      let clonePrompt: { prompt_audio: string | number; prompt_text: string } | undefined
      if (promptAsset) {
        const promptForm = new FormData()
        promptForm.set('purpose', 'prompt_audio')
        promptForm.set(
          'file',
          new Blob([Buffer.from(promptAsset.data)], { type: promptAsset.mime }),
          `prompt.${CLONE_FORMATS[promptAsset.mime.toLowerCase()]}`,
        )
        const uploadedPrompt = await request(ctx, '/v1/files/upload', promptForm)
        const promptId = uploadedPrompt.file?.file_id
        if (
          promptId === undefined ||
          (typeof promptId === 'number' && !Number.isSafeInteger(promptId))
        )
          throw new ProviderError('unknown', 'MiniMax 没有返回可用的增强参考文件 ID')
        clonePrompt = { prompt_audio: promptId, prompt_text: promptText! }
      }
      const result = await request(ctx, '/v1/voice_clone', {
        file_id: fileId,
        voice_id: voiceId,
        need_noise_reduction: noiseReduction,
        need_volume_normalization: volumeNormalization,
        ...(clonePrompt ? { clone_prompt: clonePrompt } : {}),
        ...(previewText ? { text: previewText, model: 'speech-2.8-hd' } : {}),
      })
      if (sensitive(result.input_sensitive))
        throw new ProviderError('content_policy', 'MiniMax 内容审核未通过，换一段样本再试')
      if (result.base_resp?.status_code !== 0)
        throw new ProviderError('unknown', 'MiniMax 复刻响应缺少成功状态；请先在平台核查音色 ID', {
          outcome: 'unknown',
        })
      const preview = await clonePreview(result.demo_audio, ctx)
      return { status: 'ready', ...(preview ? { preview } : {}) }
    },
  },
  voiceDesign: {
    voiceId: 'generated',
    hint: '用文字描述设计新音色，无需音频样本；试听合成会计费。',
    maxPromptLength: 2000,
    maxPreviewLength: 500,
    async design({ voiceId, prompt, previewText, image }, ctx) {
      if (image) throw new ProviderError('invalid_input', 'MiniMax 音色设计仅支持文字描述')
      required(prompt, 2000, '音色描述')
      required(previewText, 500, '试听文本')
      const result = await request(ctx, '/v1/voice_design', {
        voice_id: voiceId,
        prompt,
        preview_text: previewText,
      })
      if (typeof result.voice_id !== 'string' || !result.voice_id)
        throw new ProviderError(
          'unknown',
          'MiniMax 音色设计未返回音色 ID；请先在平台核查，避免重复创建',
          { outcome: 'unknown' },
        )
      const audio = result.trial_audio
      return {
        status: 'ready',
        voiceId: result.voice_id,
        ...(typeof audio === 'string' && /^(?:[a-f\d]{2})+$/i.test(audio)
          ? { preview: { data: new Uint8Array(Buffer.from(audio, 'hex')), mime: 'audio/mpeg' } }
          : {}),
      }
    },
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

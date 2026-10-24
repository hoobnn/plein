import { videoReferences } from '../shared/video-references'
import {
  type AssetRef,
  type CapabilityInput,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  domainAllowed,
  PLUGIN_API_VERSION,
  ProviderError,
  type ModelSpec,
  type ProviderErrorCode,
  type ProviderContext,
  type ProviderOutput,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import {
  asJson,
  imageDataUrl,
  type Json,
  type Method,
  readJson,
  redact,
  send,
  withRetry,
} from '../shared/http'
import { chatCompletion, requireSseDone } from '../shared/llm'
import { sizeByArea, tierEdge } from '../size'

const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const NETWORK = ['*.volces.com', '*.byteimg.com', '*.ibytedtos.com', '*.byteicdn.com']
const settings = z.object({
  customChatModel: z.string().default('').meta({ title: '自定义对话模型 / Endpoint ID' }),
  customImageModel: z.string().default('').meta({ title: '自定义图片模型 / Endpoint ID' }),
  customVideoModel: z.string().default('').meta({ title: '自定义视频模型 / Endpoint ID' }),
})
type Context = ProviderContext<z.output<typeof settings>>

// Seedream 宽高比 1/16–16 都能给；auto 只传分辨率档位，比例由模型按提示词决定
const SEEDREAM_ASPECTS = ['auto', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16']
// Seedance 的 ratio；auto 即 adaptive，跟随首帧或由模型决定
const SEEDANCE_ASPECTS = ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

const seedreamOptions = z.object({
  watermark: z
    .boolean()
    .default(false)
    .meta({ title: '水印', description: '在右下角加 AI 生成水印' }),
  output_format: z
    .enum(['jpeg', 'png'])
    .optional()
    .meta({ title: '输出格式', labels: { jpeg: 'JPEG', png: 'PNG' } }),
})

const seedanceOptions = (v25: boolean) =>
  z.object({
    return_last_frame: z
      .boolean()
      .optional()
      .meta({ title: '返回尾帧', description: '输出最后一帧图片，可连到下一个镜头的首帧' }),
    service_tier: z
      .enum(['default', 'flex'])
      .optional()
      .meta({
        title: '服务等级',
        description: '离线模式价格更低，排队时间更长',
        labels: { default: '在线', flex: '离线（低价）' },
      }),
    watermark: z.boolean().optional().meta({ title: '水印' }),
    ...(v25
      ? {
          draft: z
            .boolean()
            .optional()
            .meta({ title: '草稿模式', description: '先出低成本预览，仅 480p' }),
        }
      : {}),
  })

const models: ModelSpec[] = [
  {
    id: 'doubao-seed-2-1-pro-260628',
    features: ['tools'],
    title: 'Doubao Seed 2.1 Pro',
    capabilities: ['text.chat'],
  },
  {
    id: 'doubao-seed-2-1-lite-260915',
    features: ['tools'],
    title: 'Doubao Seed 2.1 Lite',
    capabilities: ['text.chat'],
  },
  {
    id: 'doubao-seed-2-1-turbo-260628',
    features: ['tools'],
    title: 'Doubao Seed 2.1 Turbo',
    capabilities: ['text.chat'],
  },
  {
    id: 'doubao-seedream-5-0-pro-260628',
    title: 'Seedream 5.0 Pro',
    capabilities: ['image.generate', 'image.process'],
    limits: {
      imageOperations: ['cutout'],
      aspectRatios: SEEDREAM_ASPECTS,
      resolutions: ['1K', '1.5K', '2K'],
      count: { max: 1 },
      references: { max: 10 },
    },
    options: seedreamOptions,
  },
  {
    id: 'doubao-seedream-5-0-flash-260915',
    title: 'Seedream 5.0 Flash',
    capabilities: ['image.generate', 'image.process'],
    limits: {
      imageOperations: ['cutout'],
      aspectRatios: SEEDREAM_ASPECTS,
      resolutions: ['1K', '1.5K', '2K'],
      count: { max: 1 },
      references: { max: 10 },
    },
    options: seedreamOptions,
  },
  {
    id: 'doubao-seedream-5-0-260128',
    title: 'Seedream 5.0 Lite（支持组图）',
    description:
      '已停止新购，计划于 2026-11-24 14:00（UTC+8）下线；现有接入请提前迁移，Pro / Flash 不支持组图',
    capabilities: ['image.generate'],
    limits: {
      aspectRatios: SEEDREAM_ASPECTS,
      resolutions: ['2K', '3K', '4K'],
      references: { max: 14 },
    },
    options: seedreamOptions,
  },
  {
    id: 'doubao-seedance-2-5-260628',
    title: 'Seedance 2.5',
    capabilities: ['video.generate'],
    limits: {
      aspectRatios: SEEDANCE_ASPECTS,
      resolutions: ['480p', '720p', '1080p'],
      duration: { min: 4, max: 30 },
      seed: false,
      references: { max: 30 },
      referenceMedia: { video: 0, audio: 10 },
    },
    options: seedanceOptions(true),
  },
  {
    id: 'doubao-seedance-2-0-260128',
    title: 'Seedance 2.0',
    capabilities: ['video.generate'],
    limits: {
      aspectRatios: SEEDANCE_ASPECTS,
      resolutions: ['480p', '720p', '1080p', '4k'],
      duration: { min: 4, max: 15 },
      seed: false,
      references: { max: 9 },
      referenceMedia: { video: 0, audio: 3 },
    },
    options: seedanceOptions(false),
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    title: 'Seedance 2.0 Fast',
    capabilities: ['video.generate'],
    limits: {
      aspectRatios: SEEDANCE_ASPECTS,
      resolutions: ['480p', '720p'],
      duration: { min: 4, max: 15 },
      seed: false,
      references: { max: 9 },
      referenceMedia: { video: 0, audio: 3 },
    },
    options: seedanceOptions(false),
  },
  {
    id: 'doubao-seedance-2-0-mini-260615',
    title: 'Seedance 2.0 Mini',
    capabilities: ['video.generate'],
    limits: {
      aspectRatios: SEEDANCE_ASPECTS,
      resolutions: ['480p', '720p'],
      duration: { min: 4, max: 15 },
      seed: false,
      references: { max: 9 },
      referenceMedia: { video: 0, audio: 3 },
    },
    options: seedanceOptions(false),
  },
  {
    id: 'custom-chat',
    title: '自定义对话模型（设置中填写）',
    capabilities: ['text.chat'],
  },
  {
    id: 'custom-image',
    title: '自定义图片模型（设置中填写）',
    capabilities: ['image.generate'],
  },
  {
    id: 'custom-video',
    title: '自定义视频模型（设置中填写）',
    capabilities: ['video.generate'],
  },
]

function invalid(message: string): never {
  throw new ProviderError('invalid_input', message)
}

function errorInfo(value: unknown, status = 0, secret?: string): ProviderError {
  const error = asJson(value)
  const name = String(error.code ?? '')
  const message = redact(
    typeof error.message === 'string' ? error.message : `火山方舟请求失败（HTTP ${status}）`,
    [secret],
  )
  const match = `${name} ${message}`.toLowerCase()
  let code: ProviderErrorCode = 'unknown'
  if (/quota|balance|insufficient|arrears/.test(match) || status === 402) code = 'quota'
  else if (/sensitive|content.?policy|content.?filter|risk|moderation/.test(match))
    code = 'content_policy'
  else if (
    status === 401 ||
    status === 403 ||
    /authentication|unauthorized|apikey|modelnotopen|accessdenied/.test(match)
  )
    code = 'auth'
  else if (status === 429 || /ratelimit|rate.?limit|bursttoofast/.test(match)) code = 'rate_limit'
  else if (status === 408 || status === 504 || /timeout|expired/.test(match)) code = 'timeout'
  else if (/cancelled|canceled/.test(match)) code = 'cancelled'
  else if (status >= 500 || /serveroverloaded|serviceunavailable/.test(match)) code = 'unavailable'
  else if ((status >= 400 && status < 500) || /invalidparameter|invalidrequest/.test(match))
    code = 'invalid_input'
  return new ProviderError(code, message)
}

async function request(
  ctx: Context,
  path: string,
  body?: Json,
  method: Method = body ? 'POST' : 'GET',
): Promise<Json> {
  const key = ctx.secret('ARK_API_KEY')
  if (!key) throw new ProviderError('auth', '请先配置 ARK_API_KEY')
  const encoded = body ? JSON.stringify(body) : undefined
  if (encoded && Buffer.byteLength(encoded, 'utf8') > 64 * 1024 * 1024)
    invalid('火山方舟请求体超过 64 MB，请缩小参考素材')
  const messages = {
    cancelled: '火山方舟请求已取消',
    network: '火山方舟网络请求失败；生成提交结果可能未知，不会自动重新提交',
  }
  const response = await send(
    ctx,
    `${BASE_URL}${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(encoded ? { body: encoded } : {}),
    },
    messages,
  )
  const value = await readJson(ctx, response, method, messages)
  if (value === null) {
    if (!response.ok) throw withRetry(errorInfo({}, response.status, key), method, response.status)
    throw new ProviderError('unknown', '火山方舟返回无效 JSON；不会自动重新提交')
  }
  const data = asJson(value)
  if (
    !response.ok ||
    (data.error && !['failed', 'cancelled', 'expired'].includes(String(data.status)))
  )
    throw withRetry(errorInfo(data.error, response.status, key), method, response.status)
  return data
}

const imageRule = {
  notImage: '火山方舟此输入仅支持图片参考；本地视频 / 音频参考需预先上传至平台素材库',
  accept: (mime: string) => /^image\/(jpeg|png|webp|bmp|tiff|gif|heic|heif)$/.test(mime),
  badMime: '参考图片 MIME 格式不受火山方舟支持',
  // 须小于 30 MB
  maxBytes: 30 * 1024 * 1024 - 1,
  tooLarge: '参考图片必须非空且小于 30 MB',
}

function imageData(ref: AssetRef, ctx: Context) {
  return imageDataUrl(ctx, ref, imageRule)
}

function extraParams(extra: Json | undefined, allowed: string[]): Json {
  for (const key of Object.keys(extra ?? {})) {
    if (!allowed.includes(key)) invalid(`火山方舟不支持 extra.${key}；不能覆盖模型、输入或请求路由`)
  }
  return { ...extra }
}

function remoteFile(url: unknown, kind: 'image' | 'video', mime: string): ProviderOutput {
  if (typeof url !== 'string') throw new ProviderError('unknown', '火山方舟响应缺少产物 URL')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ProviderError('unknown', '火山方舟返回无效产物 URL')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    !domainAllowed(NETWORK, parsed.hostname)
  )
    throw new ProviderError('unknown', '火山方舟产物 URL 超出插件的下载权限')
  return { type: 'file', kind, mime, url }
}

async function chat(model: string, input: CapabilityInput<'text.chat'>, ctx: Context) {
  if (!input.messages.length) invalid('对话至少需要一条消息')
  extraParams(input.extra, ['thinking', 'top_p', 'frequency_penalty', 'presence_penalty'])
  const key = ctx.secret('ARK_API_KEY')
  if (!key) throw new ProviderError('auth', '请先配置 ARK_API_KEY')
  return chatCompletion({
    ctx,
    label: '火山方舟',
    baseURL: BASE_URL,
    // 鉴权、传输失败和 HTTP 错误码归类沿用 request() 的规则；流必须以 [DONE] 结束
    fetch: async (url, init) => {
      const res = await send(
        ctx,
        String(url),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: String(init?.body),
        },
        {
          cancelled: '火山方舟请求已取消',
          network: '火山方舟网络请求失败；对话结果可能未知，不会自动重新提交',
        },
      )
      if (!res.ok) {
        const data = await readJson(ctx, res, 'POST', {
          cancelled: '火山方舟请求已取消',
          network: '火山方舟网络请求失败；对话结果可能未知，不会自动重新提交',
        })
        throw withRetry(errorInfo(asJson(data).error, res.status, key), 'POST')
      }
      return requireSseDone(
        res,
        () => new ProviderError('unknown', '火山方舟回答不完整或未收到 [DONE]；请勿自动重新提交'),
      )
    },
    model,
    input,
    image: (ref) => imageData(ref, ctx),
    structured: 'json_schema',
    streamError: (error) => withRetry(errorInfo(error, 200, key), 'POST'),
  })
}

async function image(model: string, input: CapabilityInput<'image.generate'>, ctx: Context) {
  if (!input.prompt.trim()) invalid('图片提示词不能为空')
  if (input.negativePrompt) invalid('Seedream 不支持独立 negativePrompt，请合并到 prompt')
  if (input.seed !== undefined && model.startsWith('doubao-seedream-5-'))
    invalid('Seedream 5.0 不支持 seed')
  const count = input.count ?? 1
  const lite = model === 'doubao-seedream-5-0-260128'
  if (!Number.isInteger(count) || count < 1 || count > 15) invalid('图片数量必须为 1–15 的整数')
  if (count > 1 && model.startsWith('doubao-seedream-5-') && !lite)
    invalid('Seedream Pro / Flash 仅支持单图；多图请选 Seedream Lite')
  const refs = input.references ?? []
  if (refs.length > (lite ? 14 : 10) || (count > 1 && refs.length + count > 15))
    invalid('参考图与生成图片数量超出所选 Seedream 模型限制')
  const body: Json = {
    // 云端默认开启；作为下游视频参考的图片默认不叠加可见水印。
    watermark: false,
    ...extraParams(input.extra, [
      'aspectRatio',
      'size',
      'watermark',
      'output_format',
      'optimize_prompt_options',
    ]),
    model,
    prompt: input.prompt,
    response_format: 'b64_json',
  }
  const aspectRatio = body.aspectRatio
  delete body.aspectRatio
  // 分辨率档位按画幅换成像素尺寸，保证画幅不丢
  if (
    input.resolution !== undefined &&
    body.size === undefined &&
    input.width === undefined &&
    input.height === undefined
  ) {
    const tokens = lite ? ['2K', '3K', '4K'] : ['1K', '1.5K', '2K']
    const edge = tierEdge(input.resolution)
    if (!model.startsWith('doubao-seedream-5-') || !tokens.includes(input.resolution) || !edge)
      invalid('所选 Seedream 模型不支持该分辨率')
    const { width, height } = sizeByArea(String(aspectRatio ?? '1:1'), edge * edge)
    // 智能画幅只给档位，比例由模型按提示词决定
    body.size = aspectRatio === 'auto' ? input.resolution : `${width}x${height}`
  }
  // Core image nodes express their frame through extra.aspectRatio. Translate it
  // into official pixel dimensions; an explicit platform size takes precedence.
  if (
    body.size === undefined &&
    input.width === undefined &&
    input.height === undefined &&
    aspectRatio !== undefined
  ) {
    const small: Record<string, string> = {
      '16:9': '2048x1152',
      '9:16': '1152x2048',
      '1:1': '2048x2048',
      '4:3': '2048x1536',
      '3:4': '1536x2048',
      '21:9': '3120x1328',
      '3:2': '2496x1664',
      '2:3': '1664x2496',
    }
    const large: Record<string, string> = {
      '16:9': '2560x1440',
      '9:16': '1440x2560',
      '1:1': '2048x2048',
      '4:3': '2304x1728',
      '3:4': '1728x2304',
      '21:9': '3120x1328',
      '3:2': '2496x1664',
      '2:3': '1664x2496',
    }
    const dimensions =
      aspectRatio === 'auto'
        ? '2K'
        : (model.startsWith('doubao-seedream-5-') && !lite ? small : large)[String(aspectRatio)]
    if (!dimensions) invalid('Seedream 不支持该图片画幅')
    body.size = dimensions
  }
  if (body.size === undefined && (input.width !== undefined || input.height !== undefined)) {
    if (
      !Number.isInteger(input.width) ||
      !Number.isInteger(input.height) ||
      input.width! < 1 ||
      input.height! < 1
    )
      invalid('图片宽高必须同时指定为正整数')
    // 像素与宽高比范围统一在下面按 size 校验
    body.size = `${input.width}x${input.height}`
  }
  if (body.size !== undefined && model.startsWith('doubao-seedream-5-')) {
    const tokens = lite ? ['2K', '3K', '4K'] : ['1K', '1.5K', '2K']
    const dimensions =
      typeof body.size === 'string' ? /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(body.size) : null
    if (dimensions) {
      const width = Number(dimensions[1])
      const height = Number(dimensions[2])
      if (
        width * height < (lite ? 3686400 : 921600) ||
        width * height > (lite ? 16777216 : 4624220) ||
        width / height < 1 / 16 ||
        width / height > 16
      )
        invalid('图片尺寸超出 Seedream 5.0 的像素 / 宽高比范围')
    } else if (!tokens.includes(String(body.size))) invalid('所选 Seedream 模型不支持该 size')
  }
  if (input.seed !== undefined) body.seed = input.seed
  if (refs.length) {
    const images = await Promise.all(refs.map((ref) => imageData(ref, ctx)))
    body.image = images.length === 1 ? images[0] : images
  }
  if (count > 1) {
    body.sequential_image_generation = 'auto'
    body.sequential_image_generation_options = { max_images: count }
  }
  const data = await request(ctx, '/images/generations', body)
  if (!Array.isArray(data.data) || !data.data.length)
    throw new ProviderError('unknown', '火山方舟响应缺少图片')
  const outputs = data.data.map((item): ProviderOutput => {
    const result = asJson(item)
    if (result.error) {
      const error = errorInfo(result.error, 0, ctx.secret('ARK_API_KEY'))
      throw new ProviderError(error.code, error.message, { retryable: false })
    }
    const format = result.output_format ?? body.output_format ?? 'jpeg'
    const mime = format === 'png' ? 'image/png' : 'image/jpeg'
    if (typeof result.b64_json === 'string' && result.b64_json.length) {
      const encoded = result.b64_json.replace(/^data:image\/[a-z]+;base64,/, '')
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
        throw new ProviderError('unknown', '火山方舟返回无效图片 Base64')
      return {
        type: 'file',
        kind: 'image',
        mime,
        data: new Uint8Array(Buffer.from(encoded, 'base64')),
      }
    }
    return remoteFile(result.url, 'image', mime)
  })
  return { state: 'succeeded' as const, outputs, usage: { images: outputs.length } }
}

async function cutout(model: string, input: CapabilityInput<'image.process'>, ctx: Context) {
  if (input.operation !== 'cutout') invalid('当前 Seedream 精修仅支持透明图层抠图')
  if (input.image.kind !== 'image') invalid('图层抠图需要图片原图')
  const source = await ctx.files.read(input.image)
  if (!['image/png', 'image/jpeg'].includes(source.mime)) invalid('图层抠图需要 PNG 或 JPEG 原图')
  const { width, height } = source
  if (!source.data.length || source.data.length > 30 * 1024 * 1024)
    invalid('图层抠图原图必须非空且不超过 30 MB')
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width / height < 1 / 16 ||
    width / height > 16 ||
    width * height < 262144 ||
    width * height > 36000000
  )
    invalid('图层抠图原图需要有效尺寸，宽高比为 1/16–16，总像素为 262144–36000000')
  const data = await request(ctx, '/images/generations', {
    model,
    image: `data:${source.mime};base64,${Buffer.from(source.data).toString('base64')}`,
    prompt: input.prompt || '将主体与背景拆分，主体作为独立透明图层，保留边缘细节',
    layer_decomposition: true,
    output_format: 'png',
    response_format: 'b64_json',
  })
  if (!Array.isArray(data.data)) throw new ProviderError('unknown', '未返回图层结果')
  const layers = data.data.map(asJson)
  const indices = new Set<number>()
  for (const layer of layers) {
    if (
      typeof layer.z_index !== 'number' ||
      !Number.isInteger(layer.z_index) ||
      layer.z_index < 0 ||
      layer.z_index > 16 ||
      indices.has(layer.z_index)
    )
      throw new ProviderError('unknown', '图层顺序信息无效；不会自动重提')
    indices.add(layer.z_index)
    if (layer.bounding_box !== undefined) {
      const box = asJson(layer.bounding_box)
      for (const coordinates of [box.absolute, box.normalized]) {
        if (
          coordinates !== undefined &&
          (!Array.isArray(coordinates) ||
            coordinates.length !== 4 ||
            coordinates.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
        )
          throw new ProviderError('unknown', '图层边界信息无效；不会自动重提')
      }
    }
  }
  const outputs: ProviderOutput[] = layers
    .filter((layer) => typeof layer.z_index === 'number' && layer.z_index > 0)
    .map((layer) => {
      if (typeof layer.b64_json === 'string') {
        const encoded = layer.b64_json.replace(/^data:image\/png;base64,/, '')
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 === 1)
          throw new ProviderError('unknown', '图层图片数据无效')
        return {
          type: 'file',
          kind: 'image',
          mime: 'image/png',
          data: new Uint8Array(Buffer.from(encoded, 'base64')),
          name: typeof layer.name === 'string' ? layer.name + '.png' : '主体图层.png',
        }
      }
      return remoteFile(layer.url, 'image', 'image/png')
    })
  if (!outputs.length)
    throw new ProviderError('unknown', '未返回独立透明图层，请在平台核对结果；不会自动重提')
  outputs.push({
    type: 'json',
    value: {
      layers: layers.map(({ z_index, bounding_box, name, description }) => ({
        z_index,
        bounding_box,
        name,
        description,
      })),
    },
  })
  return { state: 'succeeded' as const, outputs }
}

async function video(model: string, input: CapabilityInput<'video.generate'>, ctx: Context) {
  if (!input.prompt.trim() && !input.firstFrame && !input.references?.length)
    invalid('视频需要提示词或图片参考')
  if (input.lastFrame && !input.firstFrame) invalid('尾帧需要同时提供首帧')
  if ((input.firstFrame || input.lastFrame) && input.references?.length)
    invalid('首尾帧与参考图不能混用')
  const body: Json = {
    ...extraParams(input.extra, [
      'watermark',
      'return_last_frame',
      'service_tier',
      'execution_expires_after',
      'draft',
      'output_format',
    ]),
    ...(input.audio !== undefined ? { generate_audio: input.audio } : {}),
    model,
    content: [],
    resolution: input.resolution ?? '720p',
    ratio:
      input.aspectRatio === 'auto'
        ? 'adaptive'
        : (input.aspectRatio ?? (input.firstFrame ? 'adaptive' : '16:9')),
  }
  const current = model.startsWith('doubao-seedance-2-')
  const v25 = model.startsWith('doubao-seedance-2-5-')
  const maxDuration = v25 ? 30 : 15
  if (current && input.seed !== undefined) invalid('Seedance 2.0 / 2.5 不支持 seed')
  if (input.duration !== undefined) {
    if (
      !Number.isInteger(input.duration) ||
      (current && input.duration !== -1 && (input.duration < 4 || input.duration > maxDuration))
    )
      invalid(`Seedance 时长必须为 -1 或 4–${maxDuration} 的整数秒`)
    body.duration = input.duration
  }
  if (input.seed !== undefined) body.seed = input.seed
  if (
    current &&
    !['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'].includes(String(body.ratio))
  )
    invalid('Seedance 不支持该宽高比')
  const resolutions = /-(fast|mini)-/.test(model)
    ? ['480p', '720p']
    : v25
      ? ['480p', '720p', '1080p']
      : ['480p', '720p', '1080p', '4k']
  if (current && !resolutions.includes(String(body.resolution))) invalid('Seedance 不支持该分辨率')
  if (v25 && input.firstFrame && body.ratio !== 'adaptive')
    invalid('Seedance 2.5 首尾帧模式需要 adaptive 宽高比')
  if (
    current &&
    (input.references ?? []).filter((ref) => ref.kind === 'image').length > (v25 ? 30 : 9)
  )
    invalid('Seedance 参考图片过多')
  if (body.draft && (!v25 || body.resolution !== '480p'))
    invalid('draft 仅支持 Seedance 2.5 的 480p 输出')
  if (
    body.output_format !== undefined &&
    (!['mp4', 'mov'].includes(String(body.output_format)) ||
      (current && body.output_format === 'mov' && !v25))
  )
    invalid('所选 Seedance 模型不支持该 output_format')
  const content: Json[] = input.prompt ? [{ type: 'text', text: input.prompt }] : []
  for (const [ref, role] of [
    [input.firstFrame, 'first_frame'],
    [input.lastFrame, 'last_frame'],
  ] as Array<readonly [AssetRef | undefined, string]>) {
    if (ref)
      content.push({ type: 'image_url', image_url: { url: await imageData(ref, ctx) }, role })
  }
  if (input.references?.length) {
    if (input.references.some((ref) => ref.kind === 'video'))
      invalid('火山方舟本地视频参考需要先上传至平台素材库；请改用支持本地视频参考的模型')
    if (!current && input.references.some((ref) => ref.kind !== 'image'))
      invalid('当前模型不支持视频或音频参考')
    content.push(
      ...(await videoReferences(input.references, ctx, {
        image: v25 ? 30 : 9,
        video: 0,
        audio: current ? (v25 ? 10 : 3) : 0,
        duration: v25 ? 30 : 15,
        allowAudioOnly: v25,
        platform: 'ark',
      })),
    )
  }
  body.content = content
  const data = await request(ctx, '/contents/generations/tasks', body)
  if (typeof data.id !== 'string' || !data.id)
    throw new ProviderError('unknown', '火山方舟响应缺少任务 ID；不会自动重新提交')
  return { state: 'pending' as const, remoteId: data.id, pollAfterMs: 5000 }
}

export const arkProvider = defineProvider({
  id: 'volc/ark',
  title: '火山方舟',
  description: 'Doubao Seed 对话、Seedream 图片及 Seedance 视频；支持自定义模型 / Endpoint ID',
  docsUrl: 'https://docs.volcengine.com/docs/ark/model-list?lang=zh',
  settings,
  secrets: [{ name: 'ARK_API_KEY', title: '火山方舟 API Key', required: true }],
  models: models.map((model) => ({ ...model, capabilities: [...model.capabilities] })),
  async test(ctx) {
    await request(ctx, '/contents/generations/tasks?page_size=1')
  },
  async submit(req, ctx) {
    const spec = models.find((model) => model.id === req.model)
    if (!spec || !(spec.capabilities as readonly string[]).includes(req.capability))
      invalid('所选火山方舟模型不支持此能力')
    const custom =
      req.model === 'custom-chat'
        ? ctx.settings.customChatModel
        : req.model === 'custom-image'
          ? ctx.settings.customImageModel
          : req.model === 'custom-video'
            ? ctx.settings.customVideoModel
            : req.model
    const model = custom.trim()
    if (!model) invalid('请在火山方舟设置中填写自定义模型 / Endpoint ID')
    if (req.capability === 'text.chat')
      return chat(model, req.input as CapabilityInput<'text.chat'>, ctx)
    if (req.capability === 'image.generate')
      return image(model, req.input as CapabilityInput<'image.generate'>, ctx)
    if (req.capability === 'image.process')
      return cutout(model, req.input as CapabilityInput<'image.process'>, ctx)
    if (req.capability === 'video.generate')
      return video(model, req.input as CapabilityInput<'video.generate'>, ctx)
    return invalid('火山方舟不支持此能力')
  },
  async poll(remoteId, ctx) {
    const data = await request(ctx, `/contents/generations/tasks/${encodeURIComponent(remoteId)}`)
    if (data.status === 'succeeded') {
      const mov = data.output_format === 'mov'
      const content = asJson(data.content)
      const outputs = [
        remoteFile(content.video_url, 'video', mov ? 'video/quicktime' : 'video/mp4'),
      ]
      // 开了「返回尾帧」时多一张尾帧图片
      if (typeof content.last_frame_url === 'string' && content.last_frame_url)
        outputs.push(remoteFile(content.last_frame_url, 'image', 'image/jpeg'))
      return {
        state: 'succeeded',
        outputs,
        usage: {
          seconds: typeof data.duration === 'number' ? data.duration : undefined,
          outputTokens:
            typeof asJson(data.usage).completion_tokens === 'number'
              ? (asJson(data.usage).completion_tokens as number)
              : undefined,
        },
      }
    }
    if (['failed', 'cancelled', 'expired'].includes(String(data.status))) {
      const error = errorInfo(
        data.error ?? { code: data.status, message: `火山方舟视频任务 ${data.status}` },
        0,
        ctx.secret('ARK_API_KEY'),
      )
      return {
        state: 'failed',
        error: { code: error.code, message: error.message, retryable: false },
      }
    }
    if (data.status !== 'queued' && data.status !== 'running')
      throw new ProviderError('unknown', '火山方舟返回未知任务状态')
    return {
      state: 'pending',
      pollAfterMs: 5000,
      remote: data.status === 'queued' ? 'queued' : 'running',
    }
  },
  async cancel(remoteId, ctx) {
    const path = `/contents/generations/tasks/${encodeURIComponent(remoteId)}`
    const data = await request(ctx, path)
    if (data.status === 'queued') {
      await request(ctx, path, undefined, 'DELETE')
      return
    }
    if (data.status === 'running')
      throw new ProviderError('invalid_input', '火山方舟不支持取消已经运行的视频任务')
    if (!['succeeded', 'failed', 'cancelled', 'expired'].includes(String(data.status)))
      throw new ProviderError('unknown', '火山方舟返回未知任务状态，未执行取消')
  },
})

export const arkPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'volc/ark',
      version: '0.1.0',
      name: '火山方舟',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['volc/ark'] },
      permissions: { network: NETWORK, secrets: ['ARK_API_KEY'], assets: 'read' },
    },
  }),
  { providers: [arkProvider] },
)

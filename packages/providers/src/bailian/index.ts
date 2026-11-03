import {
  type AssetRef,
  type CapabilityInput,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  type MediaRequirements,
  PLUGIN_API_VERSION,
  type ProviderContext,
  ProviderError,
  type ProviderOutput,
  type ProviderUsage,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { imageModelProblem, mediaBatchProblems, mediaRequirementProblems } from '@plein/plugin-sdk'
import { sizeByArea, tierEdge } from '../size'
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
import { openAiModelList } from '../shared/model-list'

const settings = z.object({
  region: z
    .enum(['cn-beijing', 'ap-southeast-1', 'us-east-1'])
    .default('cn-beijing')
    .meta({ title: '地域（须与 API Key 一致）' }),
  workspaceId: z
    .string()
    .regex(/^[a-zA-Z0-9-]*$/)
    .default('')
    .meta({ title: '业务空间 ID（留空使用 DashScope 兼容端点）' }),
  voice: z.string().default('Cherry').meta({ title: '默认音色' }),
  language: z.string().default('Auto').meta({ title: '语音语言' }),
  pollIntervalMs: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(10000)
    .meta({ title: '任务轮询间隔（毫秒）' }),
})
type Context = ProviderContext<z.output<typeof settings>>
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function key(ctx: Context) {
  const value = ctx.secret('DASHSCOPE_API_KEY')?.trim()
  if (!value) throw new ProviderError('auth', '请配置 DASHSCOPE_API_KEY')
  return value
}
function host(ctx: Context) {
  const { region, workspaceId } = ctx.settings
  if (workspaceId) return `https://${workspaceId}.${region}.maas.aliyuncs.com`
  return region === 'cn-beijing'
    ? 'https://dashscope.aliyuncs.com'
    : region === 'ap-southeast-1'
      ? 'https://dashscope-intl.aliyuncs.com'
      : 'https://dashscope-us.aliyuncs.com'
}
function remoteError(status: number, value: unknown, ctx: Context) {
  const data = asJson(value),
    error = asJson(data.error)
  const code = String(error.code ?? data.code ?? '').toLowerCase()
  const secret = ctx.secret('DASHSCOPE_API_KEY')?.trim()
  const message = redact(String(error.message ?? data.message ?? `百炼 HTTP ${status}`), [secret], {
    mask: '[REDACTED]',
    tokens: true,
  })
  const normalized =
    status === 401 || status === 403 || /apikey|accessdenied|unauthorized/.test(code)
      ? 'auth'
      : /quota|arrear|balance|insufficient/.test(code)
        ? 'quota'
        : /inspection|inappropriate|safety|contentfilter/.test(code)
          ? 'content_policy'
          : status === 429 || /throttl|ratelimit/.test(code)
            ? 'rate_limit'
            : status === 408 || status === 504
              ? 'timeout'
              : status >= 500
                ? 'unavailable'
                : status >= 400 || /invalid|unsupported/.test(code)
                  ? 'invalid_input'
                  : 'unknown'
  return new ProviderError(normalized, message)
}
function requestMessages(method: Method) {
  const failed =
    method === 'GET' ? '百炼请求中断或网络不可用' : '百炼提交状态未知；请先恢复查询，勿重新生成'
  return { cancelled: failed, network: failed, timeout: failed }
}
async function response(
  ctx: Context,
  path: string,
  body?: Json,
  asyncTask = false,
): Promise<Response> {
  const method: Method = body === undefined ? 'GET' : 'POST'
  const messages = requestMessages(method)
  const res = await send(
    ctx,
    host(ctx) + path,
    {
      method,
      headers: {
        Authorization: `Bearer ${key(ctx)}`,
        'Content-Type': 'application/json',
        ...(asyncTask ? { 'X-DashScope-Async': 'enable' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    messages,
  )
  if (!res.ok) {
    const data = await readJson(ctx, res, method, messages)
    throw withRetry(remoteError(res.status, data, ctx), method, res.status)
  }
  return res
}
async function request(ctx: Context, path: string, body?: Json, asyncTask = false): Promise<Json> {
  const res = await response(ctx, path, body, asyncTask)
  const method = body === undefined ? 'GET' : 'POST'
  const value = await readJson(ctx, res, method, requestMessages(method))
  if (value === null)
    throw new ProviderError('unknown', '百炼返回无效 JSON；请勿自动重新提交生成任务')
  const data = asJson(value)
  if (Object.keys(data).length === 0) throw new ProviderError('unknown', '百炼返回空响应')
  if (data.code || data.error)
    throw withRetry(
      remoteError(res.status, data, ctx),
      body === undefined ? 'GET' : 'POST',
      res.status,
    )
  return data
}
function usage(data: Json): ProviderUsage {
  const u = asJson(data.usage)
  return {
    inputTokens:
      typeof u.input_tokens === 'number'
        ? u.input_tokens
        : typeof u.prompt_tokens === 'number'
          ? u.prompt_tokens
          : undefined,
    outputTokens:
      typeof u.output_tokens === 'number'
        ? u.output_tokens
        : typeof u.completion_tokens === 'number'
          ? u.completion_tokens
          : undefined,
    images:
      typeof u.image_count === 'number'
        ? u.image_count
        : typeof u.output_image_count === 'number'
          ? u.output_image_count
          : undefined,
    characters: typeof u.characters === 'number' ? u.characters : undefined,
    seconds: typeof u.duration === 'number' ? u.duration : undefined,
  }
}
function inline(ref: AssetRef, ctx: Context) {
  return imageDataUrl(ctx, ref, {
    accept: (mime) => mime.startsWith('image/'),
    badMime: '参考资产必须是图片',
    maxBytes: 10 * 1024 * 1024,
    tooLarge: '参考图片超过 10 MB',
    allowEmpty: true,
  })
}
async function upload(
  ref: AssetRef,
  model: string,
  ctx: Context,
  source?: Awaited<ReturnType<Context['files']['read']>>,
) {
  const { data, mime } = source ?? (await ctx.files.read(ref))
  const ext = (
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
      'image/tiff': 'tiff',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/mpeg': 'mp3',
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
    } as Record<string, string>
  )[mime]
  if (!ext) throw new ProviderError('invalid_input', `万相参考素材格式不支持：${mime}`)
  const maxBytes = mime.startsWith('image/')
    ? 20 * 1024 * 1024
    : mime.startsWith('audio/')
      ? 15 * 1024 * 1024
      : 100 * 1024 * 1024
  if (data.length > maxBytes) throw new ProviderError('invalid_input', '万相参考素材超过大小限制')
  const policy = asJson(
    (await request(ctx, `/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`))
      .data,
  )
  if (typeof policy.upload_host !== 'string' || typeof policy.upload_dir !== 'string')
    throw new ProviderError('unknown', '百炼上传凭证缺少地址')
  const name = `${crypto.randomUUID()}.${ext}`
  const objectKey = `${policy.upload_dir}/${name}`
  const form = new FormData()
  for (const [field, source] of Object.entries({
    OSSAccessKeyId: 'oss_access_key_id',
    Signature: 'signature',
    policy: 'policy',
    'x-oss-object-acl': 'x_oss_object_acl',
    'x-oss-forbid-overwrite': 'x_oss_forbid_overwrite',
  })) {
    if (typeof policy[source] !== 'string') throw new ProviderError('unknown', '百炼上传凭证不完整')
    form.append(field, policy[source] as string)
  }
  form.append('key', objectKey)
  form.append('success_action_status', '200')
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), name)
  let res: Response
  try {
    res = await ctx.fetch(policy.upload_host, { method: 'POST', body: form, signal: ctx.signal })
  } catch (e) {
    throw new ProviderError(ctx.signal.aborted ? 'cancelled' : 'unavailable', '参考素材上传失败', {
      cause: e,
    })
  }
  if (!res.ok) throw remoteError(res.status, {}, ctx)
  return `oss://${objectKey}`
}
const generation = '/api/v1/services/aigc/multimodal-generation/generation'
function file(kind: 'image' | 'video' | 'audio', url: unknown): ProviderOutput {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url))
    throw new ProviderError('unknown', '百炼生成结果缺少文件地址')
  // 官方 OSS 结果可能返回 HTTP 链接；同域名及签名改用 HTTPS 下载。
  const secureUrl = new URL(url)
  secureUrl.protocol = 'https:'
  return {
    type: 'file',
    kind,
    url: secureUrl.href,
    mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav',
    name: `bailian.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'wav'}`,
  }
}

const supported: Partial<Record<string, string[]>> = {
  'text.chat': ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'],
  'image.generate': ['qwen-image-3.0-pro', 'qwen-image-3.0', 'wan2.7-image-pro'],
  'image.edit': ['wanx2.1-imageedit'],
  'image.process': ['wanx2.1-imageedit'],
  'video.generate': ['wan3.0-video', 'wan3.0-video-prime'],
  'audio.speech': ['qwen3-tts-flash'],
}
const IMAGE_ASPECTS = ['auto', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16']
// 万相视频的 ratio；auto 即 adaptive，跟随素材或由模型决定
const VIDEO_ASPECTS = ['auto', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']

/**
 * 万相视频的参考素材要求：参考视频与参考音频各自总时长不超过 15 秒，
 * 参考视频加输出时长不超过 30 秒。宿主在运行前读的是同一份声明。
 */
const WAN_REFERENCE_MEDIA: MediaRequirements = {
  image: {
    mime: ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff'],
    maxMB: 20,
  },
  video: {
    mime: ['video/mp4', 'video/quicktime'],
    maxMB: 100,
    minDuration: 0,
    totalDurationMax: 15,
    totalWithOutputMax: 30,
    outputDurationDefault: 5,
  },
  audio: {
    mime: ['audio/wav', 'audio/x-wav', 'audio/mpeg'],
    maxMB: 15,
    minDuration: 0,
    totalDurationMax: 15,
  },
}

/** 万相精修原图的要求：JPEG/PNG/BMP/TIFF/WEBP、10 MB 以内、宽高 512–4096 */
const WAN_PROCESS_MEDIA: MediaRequirements = {
  process: {
    mime: ['image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'image/webp'],
    maxMB: 10,
    minEdge: 512,
    maxEdge: 4096,
  },
}

export const bailianProvider = defineProvider({
  testScope: 'configuration',
  id: 'aliyun/bailian',
  title: '阿里云百炼',
  description: '千问对话、图像、万相视频和语音合成；连接测试仅检查本地配置，不调用计费模型',
  docsUrl: 'https://help.aliyun.com/zh/model-studio/',
  settings,
  secrets: [
    {
      name: 'DASHSCOPE_API_KEY',
      title: '百炼 API Key',
      required: true,
      help: '密钥地域须与设置一致；连接测试仅检查是否填写，不验证账户权限或余额',
    },
  ],
  models: [
    // 官方文档标注 qwen3.8-max / qwen3.8-flash / qwen3.7-plus 支持图像与视频理解，故声明 vision
    ...['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'].map((id) => ({
      id,
      title: id,
      capabilities: ['text.chat' as const],
      features: ['tools' as const, 'vision' as const],
    })),
    ...['qwen-image-3.0-pro', 'qwen-image-3.0'].map((id) => ({
      id,
      title: id,
      capabilities: ['image.generate' as const],
      limits: {
        aspectRatios: IMAGE_ASPECTS,
        resolutions: ['1K', '2K'],
        count: { max: 6 },
        references: { max: 3 },
        image: {
          referenceForbiddenOptions: { prompt_extend_mode: ['agent'] },
          resolutionRequiresAspectRatio: true,
          size: {
            minPixels: 512 ** 2,
            maxPixels: 2048 ** 2,
            minRatio: 1 / 8,
            maxRatio: 8,
            auto: true,
          },
        },
      },
      options: z.object({
        negative_prompt: z
          .string()
          .optional()
          .meta({ title: '反向提示词', placeholder: '不希望出现的内容' }),
        size: z.string().optional().meta({
          title: '自定义尺寸',
          placeholder: '如 2048*2048 或 auto',
          description: '留空用画幅 / 分辨率；填写后优先于画幅和分辨率',
        }),
        prompt_extend: z.boolean().optional().meta({ title: '提示词扩写' }),
        prompt_extend_mode: z
          .enum(['direct', 'agent'])
          .optional()
          .meta({
            title: '扩写方式',
            labels: { direct: '直接增强', agent: '智能体增强（仅文生图）' },
          }),
        enable_thinking: z.boolean().optional().meta({ title: '思考模式' }),
        watermark: z.boolean().optional().meta({ title: '水印' }),
      }),
    })),
    {
      id: 'wan2.7-image-pro',
      title: 'wan2.7-image-pro',
      capabilities: ['image.generate' as const],
      limits: {
        aspectRatios: IMAGE_ASPECTS,
        resolutions: ['1K', '2K', '4K'],
        count: { max: 4 },
        references: { max: 9 },
        promptMaxLength: 5000,
        image: {
          referenceResolutions: ['1K', '2K'],
          sequential: { option: 'enable_sequential', maxCount: 12, resolutions: ['1K', '2K'] },
          size: {
            minPixels: 768 ** 2,
            maxPixels: 4096 ** 2,
            maxPixelsWithReferences: 2048 ** 2,
            maxPixelsSequential: 2048 ** 2,
            minRatio: 1 / 8,
            maxRatio: 8,
            tiers: ['1K', '2K', '4K'],
          },
        },
      },
      options: z.object({
        negative_prompt: z
          .string()
          .optional()
          .meta({ title: '反向提示词', placeholder: '不希望出现的内容' }),
        prompt_extend: z
          .boolean()
          .optional()
          .meta({ title: '提示词扩写', description: '由模型自动润色、补充提示词' }),
        thinking_mode: z.boolean().optional().meta({ title: '思考模式' }),
        enable_sequential: z.boolean().optional().meta({
          title: '组图模式',
          description: '最多 12 张、最高 2K；张数为最大数量，实际张数由模型决定',
        }),
        size: z.string().optional().meta({
          title: '自定义尺寸',
          placeholder: '如 3840*2160',
          description: '留空用画幅 / 分辨率；填写后优先于画幅和分辨率',
        }),
        watermark: z.boolean().optional().meta({ title: '水印' }),
      }),
    },
    {
      id: 'wanx2.1-imageedit',
      title: '万相图像编辑（局部重绘）',
      description: 'Legacy，仅华北2（北京）地域；按蒙版只重绘白色区域，原生蒙版能力',
      capabilities: ['image.edit' as const, 'image.process' as const],
      limits: {
        count: { max: 1 },
        // 精修（image.process）提示词上限 800 字；同一模型的局部重绘共用此上限
        promptMaxLength: 800,
        imageOperations: ['upscale' as const, 'outpaint' as const],
        media: WAN_PROCESS_MEDIA,
      },
    },
    ...['wan3.0-video', 'wan3.0-video-prime'].map((id) => ({
      id,
      title: id,
      capabilities: ['video.generate' as const],
      limits: {
        aspectRatios: VIDEO_ASPECTS,
        resolutions: ['480P', '720P', '1080P'],
        defaultResolution: '720P',
        duration: { min: 2, max: 30 },
        references: { max: 10 },
        referenceMedia: { video: 5, audio: 5 },
        videoModes: ['text', 'image', 'frames', 'reference'] as const,
        media: WAN_REFERENCE_MEDIA,
      },
      options: z.object({
        adaptive_duration: z
          .boolean()
          .optional()
          .meta({ title: '自动时长', description: '由模型在有效范围内选择时长' }),
        prompt_extend: z
          .boolean()
          .optional()
          .meta({ title: '提示词扩写', description: '由模型自动润色、补充提示词' }),
        watermark: z.boolean().optional().meta({ title: '水印' }),
      }),
    })),
    {
      id: 'qwen3-tts-flash',
      title: 'qwen3-tts-flash',
      capabilities: ['audio.speech' as const],
      limits: { speed: false as const, instruction: false, promptMaxLength: 600 },
    },
    {
      id: 'qwen3-tts-instruct-flash',
      title: 'qwen3-tts-instruct-flash',
      description: '已于 2026-10-10 下线；仅保留旧画布引用，请改用 qwen3-tts-flash 或豆包语音',
      deprecated: true,
      capabilities: ['audio.speech' as const],
      limits: { speed: false as const, promptMaxLength: 600 },
    },
  ],
  async test(ctx) {
    key(ctx)
    ctx.log('本地密钥配置已填写；未验证网络、鉴权、模型权限或余额，未调用计费接口')
  },
  async submit(req, ctx) {
    key(ctx)
    if (req.model === 'qwen3-tts-instruct-flash')
      throw new ProviderError(
        'invalid_input',
        'qwen3-tts-instruct-flash 已下线；请选择 qwen3-tts-flash，语气指令请使用豆包语音',
      )
    if (
      !supported[req.capability]?.includes(req.model) &&
      !(req.remoteOnly && req.capability === 'text.chat')
    )
      throw new ProviderError('invalid_input', `百炼模型 ${req.model} 不支持 ${req.capability}`)
    switch (req.capability) {
      case 'text.chat':
        return chatCompletion({
          ctx,
          label: '百炼',
          baseURL: `${host(ctx)}/compatible-mode/v1`,
          // 鉴权、传输失败和 HTTP 错误码归类沿用 response()；流必须以 [DONE] 结束
          fetch: async (url, init) => {
            const path = String(url).slice(host(ctx).length)
            const body = JSON.parse(String(init?.body)) as Json
            return requireSseDone(
              await response(ctx, path, body),
              () => new ProviderError('unknown', '百炼回答不完整或未收到 [DONE]；请勿自动重新提交'),
            )
          },
          model: req.model,
          input: req.input as CapabilityInput<'text.chat'>,
          image: (ref) => inline(ref, ctx),
          structured: 'json_object',
          streamError: (error) => withRetry(remoteError(200, { error }, ctx), 'POST'),
        })
      case 'image.generate': {
        const input = req.input as CapabilityInput<'image.generate'>
        if (!input.prompt.trim()) throw new ProviderError('invalid_input', '图片提示词不能为空')
        const spec = bailianProvider.models.find((m) => m.id === req.model)!
        const qwen = req.model.startsWith('qwen-image-3.0')
        if ((input.width === undefined) !== (input.height === undefined))
          throw new ProviderError('invalid_input', '图片宽高须一起填写')
        const parsed = spec.options?.safeParse(input.extra ?? {})
        if (parsed && !parsed.success)
          throw new ProviderError('invalid_input', '百炼图片专属参数无效')
        const extra = Object.fromEntries(
          Object.entries(input.extra ?? {}).filter(([k]) =>
            [
              'size',
              'n',
              'seed',
              'watermark',
              'negative_prompt',
              'prompt_extend',
              ...(qwen
                ? ['prompt_extend_mode', 'enable_thinking']
                : ['enable_sequential', 'thinking_mode']),
            ].includes(k),
          ),
        )
        const n = input.count ?? extra.n ?? 1
        const refs = input.references?.length ?? 0
        if (!qwen && input.prompt.length > 5000)
          throw new ProviderError('invalid_input', '万相图片提示词最多 5000 字符')
        const aspect =
          typeof input.extra?.aspectRatio === 'string' ? input.extra.aspectRatio : '16:9'
        const combination = imageModelProblem(
          spec,
          {
            count: n,
            resolution: input.resolution,
            aspectRatio: aspect,
            options: {
              ...extra,
              ...(input.width !== undefined && !extra.size
                ? { size: `${input.width}*${input.height}` }
                : {}),
            },
          },
          refs,
        )
        if (combination) throw new ProviderError('invalid_input', combination)
        let size =
          extra.size || (input.width !== undefined ? `${input.width}*${input.height}` : undefined)
        if (size === '1K' || size === '2K' || size === '4K') {
          if (qwen)
            throw new ProviderError('invalid_input', 'Qwen 原生 size 需要像素尺寸，不接受 K 档位')
          if (
            !spec.limits?.resolutions?.includes(size) ||
            (size === '4K' && (refs || extra.enable_sequential === true))
          )
            throw new ProviderError('invalid_input', '万相当前模式不支持该分辨率')
        } else if (!size && input.resolution) {
          const edge = tierEdge(input.resolution)
          if (!edge || !spec.limits?.resolutions?.includes(input.resolution))
            throw new ProviderError('invalid_input', '所选百炼图片模型不支持该分辨率')
          if (aspect === 'auto' && !qwen) size = input.resolution
          else {
            const { width, height } = sizeByArea(aspect, edge * edge)
            size = `${width}*${height}`
          }
        } else if (!size && aspect !== 'auto') {
          const ratios: Record<string, string> = {
            '16:9': '1664*936',
            '9:16': '936*1664',
            '1:1': '1024*1024',
            '4:3': '1536*1152',
            '3:4': '1152*1536',
            '21:9': '1904*816',
            '3:2': '1536*1024',
            '2:3': '1024*1536',
          }
          size = ratios[aspect]
        }
        const issue = imageModelProblem(
          spec,
          {
            count: n,
            resolution: input.resolution,
            aspectRatio: aspect,
            options: { ...extra, size },
          },
          refs,
        )
        if (issue) throw new ProviderError('invalid_input', issue)
        // DashScope 的智能尺寸通过省略 size 表达；Qwen 不接受 K 字符串。
        if (
          extra.size &&
          size !== 'auto' &&
          !/^(?:1K|2K|4K|[1-9]\d*[x*][1-9]\d*)$/.test(String(size))
        )
          throw new ProviderError('invalid_input', '自定义尺寸格式无效')
        if (typeof size === 'string') size = size.replace('x', '*')
        if (size === 'auto') size = undefined
        const seed = input.seed ?? extra.seed
        if (
          seed !== undefined &&
          (!Number.isInteger(seed) || Number(seed) < 0 || Number(seed) > 2147483647)
        )
          throw new ProviderError('invalid_input', '百炼图片 seed 须为 0–2147483647 的整数')
        const content: Json[] = [{ text: input.prompt }]
        for (const ref of input.references ?? []) content.push({ image: await inline(ref, ctx) })
        const data = await request(ctx, generation, {
          model: req.model,
          input: { messages: [{ role: 'user', content }] },
          parameters: {
            watermark: false,
            ...extra,
            size,
            n,
            ...(seed !== undefined ? { seed } : {}),
            ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
          },
        })
        const outputs = arr(asJson(data.output).choices)
          .flatMap((c) => arr(asJson(asJson(c).message).content))
          .map(asJson)
          .filter((p) => p.image)
          .map((p) => file('image', p.image))
        if (!outputs.length) throw new ProviderError('unknown', '百炼没有返回生成图片')
        return { state: 'succeeded', outputs, usage: usage(data) }
      }
      case 'image.process': {
        const input = req.input as CapabilityInput<'image.process'>
        if (!['upscale', 'outpaint'].includes(input.operation))
          throw new ProviderError('invalid_input', '万相精修支持 AI 放大和扩图')
        if (input.image.kind !== 'image')
          throw new ProviderError('invalid_input', '万相精修需要图片原图')
        if (input.prompt && input.prompt.length > 800)
          throw new ProviderError('invalid_input', '万相精修提示词不能超过 800 字')
        const parameters: Record<string, unknown> = { n: 1 }
        if (input.operation === 'upscale') {
          const factor = input.scale ?? 2
          if (!Number.isFinite(factor) || factor < 1 || factor > 4)
            throw new ProviderError('invalid_input', 'AI 放大倍数须为 1–4')
          parameters.upscale_factor = factor
        } else {
          const expansion = input.expansion ?? { top: 1, bottom: 1, left: 1.5, right: 1.5 }
          for (const side of ['top', 'bottom', 'left', 'right'] as const) {
            if (!Number.isFinite(expansion[side]) || expansion[side] < 1 || expansion[side] > 2)
              throw new ProviderError('invalid_input', '扩图比例须为 1–2')
            parameters[side + '_scale'] = expansion[side]
          }
        }
        const source = await ctx.files.read(input.image)
        if (!source.data.length)
          throw new ProviderError('invalid_input', '万相精修原图不能是空文件')
        // 原图的格式要求以模型声明为准，宿主在运行前读的是同一份声明
        const spec = bailianProvider.models.find((m) => m.id === req.model)
        const problems = mediaRequirementProblems(
          spec?.limits?.media?.process,
          {
            mime: source.mime,
            size: source.data.length,
            width: source.width,
            height: source.height,
          },
          { title: spec?.title ?? '当前模型', label: '万相精修原图', strict: true },
        )
        if (problems.length) throw new ProviderError('invalid_input', problems[0]!)
        const data = await requestWithOss(
          ctx,
          '/api/v1/services/aigc/image2image/image-synthesis',
          {
            model: req.model,
            input: {
              function: input.operation === 'upscale' ? 'super_resolution' : 'expand',
              prompt: input.prompt ?? '',
              base_image_url: await upload(input.image, req.model, ctx, source),
            },
            parameters,
          },
        )
        const output = asJson(data.output)
        if (typeof output.task_id !== 'string' || !output.task_id)
          throw new ProviderError('unknown', '百炼未返回 task_id；请勿重新提交任务')
        return {
          state: 'pending',
          remoteId: output.task_id,
          pollAfterMs: ctx.settings.pollIntervalMs,
        }
      }
      case 'image.edit': {
        const input = req.input as CapabilityInput<'image.edit'>
        if (!input.prompt.trim()) throw new ProviderError('invalid_input', '局部重绘需要提示词')
        const count = input.count ?? 1
        if (count !== 1) throw new ProviderError('invalid_input', '万相图像编辑一次仅支持生成 1 张')
        // 通用图像编辑的蒙版重绘：白色区域按提示词重画，其余保持原图；异步任务
        const body = {
          model: req.model,
          input: {
            function: 'description_edit_with_mask',
            prompt: input.prompt,
            base_image_url: await upload(input.image, req.model, ctx),
            mask_image_url: await upload(input.mask, req.model, ctx),
          },
          parameters: {
            ...input.extra,
            n: count,
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
          },
        }
        const data = await requestWithOss(
          ctx,
          '/api/v1/services/aigc/image2image/image-synthesis',
          body,
        )
        const output = asJson(data.output)
        if (typeof output.task_id !== 'string' || !output.task_id)
          throw new ProviderError('unknown', '百炼未返回 task_id；请勿重新提交任务')
        return {
          state: 'pending',
          remoteId: output.task_id,
          pollAfterMs: ctx.settings.pollIntervalMs,
        }
      }
      case 'video.generate': {
        const input = req.input as CapabilityInput<'video.generate'>
        if (!input.prompt.trim() && !input.firstFrame && !input.references?.length)
          throw new ProviderError('invalid_input', '视频需要提示词或参考素材')
        if (input.lastFrame && !input.firstFrame)
          throw new ProviderError('invalid_input', '尾帧须与首帧一起填写')
        if ((input.firstFrame || input.lastFrame) && input.references?.length)
          throw new ProviderError('invalid_input', '首尾帧不能与参考素材混用')
        if (
          (input.firstFrame && input.firstFrame.kind !== 'image') ||
          (input.lastFrame && input.lastFrame.kind !== 'image')
        )
          throw new ProviderError('invalid_input', '首尾帧须为图片资产')
        if (
          input.duration !== undefined &&
          input.duration !== -1 &&
          (!Number.isInteger(input.duration) || input.duration < 2 || input.duration > 30)
        )
          throw new ProviderError('invalid_input', '万相视频时长须为 -1 或 2–30 秒整数')
        for (const [kind, limit] of [
          ['image', 10],
          ['audio', 5],
          ['video', 5],
        ] as const) {
          if ((input.references ?? []).filter((ref) => ref.kind === kind).length > limit)
            throw new ProviderError('invalid_input', `万相 ${kind} 参考数量超过 ${limit}`)
        }
        const spec = bailianProvider.models.find((m) => m.id === req.model)!
        const defaultResolution = spec.limits?.defaultResolution
        if (!defaultResolution)
          throw new ProviderError('unknown', '所选万相视频模型未声明默认分辨率')
        const resolution = input.resolution ?? defaultResolution
        const ratio = input.aspectRatio === 'auto' ? 'adaptive' : (input.aspectRatio ?? '16:9')
        if (!spec.limits?.resolutions?.includes(resolution))
          throw new ProviderError('invalid_input', '万相不支持该视频分辨率')
        if (ratio !== 'adaptive' && !spec.limits?.aspectRatios?.includes(ratio))
          throw new ProviderError('invalid_input', '万相不支持该视频画幅')
        const parsed = spec.options!.safeParse(input.extra ?? {})
        if (!parsed.success) throw new ProviderError('invalid_input', '万相视频专属参数无效')
        const { adaptive_duration, ...extra } = parsed.data
        const sources = new Map<string, Awaited<ReturnType<Context['files']['read']>>>()
        const mediaLimits = spec.limits?.media
        for (const ref of input.references ?? []) {
          if (ref.kind !== 'image' && ref.kind !== 'audio' && ref.kind !== 'video')
            throw new ProviderError('invalid_input', '视频参考素材须为图片、音频或视频')
          const source = await ctx.files.read(ref)
          sources.set(ref.assetId, source)
        }
        for (const kind of ['image', 'video', 'audio'] as const) {
          const samples = (input.references ?? [])
            .filter((ref) => ref.kind === kind)
            .map((ref) => {
              const source = sources.get(ref.assetId)
              return {
                sample: {
                  mime: source?.mime,
                  size: source?.data.length,
                  duration: source?.duration,
                },
              }
            })
          const problems = mediaBatchProblems({
            requirement: mediaLimits?.[kind],
            samples,
            title: spec.title,
            label: kind === 'video' ? '参考视频' : kind === 'audio' ? '参考音频' : '参考图片',
            strict: true,
            // 自适应时长与 -1 由模型决定输出时长，这时不与输出时长相加
            ...(kind === 'video'
              ? {
                  outputDuration: input.duration,
                  outputDurationByModel: adaptive_duration === true || input.duration === -1,
                }
              : {}),
          })
          if (problems.length) throw new ProviderError('invalid_input', problems[0]!)
        }
        const media: Json[] = []
        if (input.firstFrame)
          media.push({ type: 'first_frame', url: await upload(input.firstFrame, req.model, ctx) })
        if (input.lastFrame)
          media.push({ type: 'last_frame', url: await upload(input.lastFrame, req.model, ctx) })
        for (const ref of input.references ?? []) {
          if (ref.kind !== 'image' && ref.kind !== 'audio' && ref.kind !== 'video')
            throw new ProviderError('invalid_input', '视频参考素材须为图片、音频或视频')
          media.push({
            type: `reference_${ref.kind}`,
            url: await upload(ref, req.model, ctx, sources.get(ref.assetId)),
          })
        }
        // OSS resolution is mandatory for uploaded assets; use the same scoped fetch.
        const body = {
          model: req.model,
          input: { prompt: input.prompt, ...(media.length ? { media } : {}) },
          parameters: {
            resolution,
            ratio,
            watermark: false,
            ...extra,
            audio: input.audio ?? true,
            ...(adaptive_duration === true
              ? { duration: -1 }
              : input.duration !== undefined
                ? { duration: input.duration }
                : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
          },
        }
        const path = '/api/v1/services/aigc/video-generation/video-synthesis'
        const data = media.length
          ? await requestWithOss(ctx, path, body)
          : await request(ctx, path, body, true)
        const output = asJson(data.output)
        if (typeof output.task_id !== 'string' || !output.task_id)
          throw new ProviderError('unknown', '百炼未返回 task_id；请勿重新提交任务')
        return {
          state: 'pending',
          remoteId: output.task_id,
          pollAfterMs: ctx.settings.pollIntervalMs,
        }
      }
      case 'audio.speech': {
        const input = req.input as CapabilityInput<'audio.speech'>
        // oxlint-disable-next-line typescript/no-misused-spread -- 平台按 Unicode 码点计字数
        if (!input.text.trim() || [...input.text].length > 600)
          throw new ProviderError('invalid_input', '千问语音文本须为 1–600 字符')
        if (
          input.instruction ||
          ['instruction', 'instructions', 'optimize_instructions'].some(
            (field) => input.extra?.[field] !== undefined,
          )
        )
          throw new ProviderError('invalid_input', 'qwen3-tts-flash 不支持语气指令，请使用豆包语音')
        if (input.speed !== undefined && input.speed !== 1)
          throw new ProviderError(
            'invalid_input',
            '千问 TTS 不支持 speed 参数；可使用 instruct 模型描述语速',
          )
        const data = await request(ctx, generation, {
          model: req.model,
          input: {
            ...input.extra,
            text: input.text,
            voice: input.voice ?? ctx.settings.voice,
            language_type: ctx.settings.language,
          },
        })
        return {
          state: 'succeeded',
          outputs: [file('audio', asJson(asJson(data.output).audio).url)],
          usage: usage(data),
        }
      }
      default:
        throw new ProviderError('invalid_input', `百炼暂不支持 ${req.capability}`)
    }
  },
  async poll(remoteId, ctx) {
    const data = await request(ctx, `/api/v1/tasks/${encodeURIComponent(remoteId)}`)
    const output = asJson(data.output),
      status = output.task_status
    if (status === 'PENDING' || status === 'RUNNING')
      return {
        state: 'pending',
        pollAfterMs: ctx.settings.pollIntervalMs,
        remote: status === 'PENDING' ? 'queued' : 'running',
      }
    if (status === 'SUCCEEDED') {
      // 图像编辑的结果是 results 数组（每张一个 url，单张失败的带 code）；视频是 video_url
      if (Array.isArray(output.results)) {
        const urls = output.results.map(asJson).filter((r) => typeof r.url === 'string')
        if (!urls.length) throw new ProviderError('unknown', '百炼没有返回编辑后的图片')
        return {
          state: 'succeeded',
          outputs: urls.map((r) => file('image', r.url)),
          usage: usage(data),
        }
      }
      return {
        state: 'succeeded',
        outputs: [file('video', output.video_url ?? asJson(output.results).video_url)],
        usage: usage(data),
      }
    }
    if (status === 'CANCELED' || status === 'CANCELLED')
      return { state: 'failed', error: { code: 'cancelled', message: '百炼任务已取消' } }
    // 查询异常不等于远端生成失败；抛错让宿主保留任务 ID，避免恢复时再次付费提交。
    if (status !== 'FAILED')
      throw new ProviderError('unknown', '百炼返回未知任务状态，请保留原任务并恢复查询')
    const e = remoteError(200, output, ctx)
    return {
      state: 'failed',
      error: {
        code: e.code,
        message: output.message ? e.message : `百炼任务状态：${String(status ?? 'UNKNOWN')}`,
        retryable: e.retryable,
      },
    }
  },
  async cancel(remoteId, ctx) {
    const data = await request(ctx, `/api/v1/tasks/${encodeURIComponent(remoteId)}/cancel`, {})
    const output = asJson(data.output)
    if (
      output.code ||
      (output.task_status && !['CANCELED', 'CANCELLED'].includes(String(output.task_status)))
    )
      throw remoteError(400, output, ctx)
  },
  // 兼容模式列表以对话模型为主；是否含图片 / 视频模型未在官方文档确证，先只覆盖对话
  remoteModelsScope: ['text.chat'],
  // 地域与业务空间影响列表域名与返回内容，都参与缓存键
  remoteModelsSettings: ['region', 'workspaceId'],
  // OpenAI 兼容模式的模型列表；业务空间域名的列表接口未确证，暂不支持
  listRemoteModels: async (ctx) => {
    if (ctx.settings.workspaceId)
      throw new ProviderError(
        'invalid_input',
        '业务空间模式暂不支持拉取远端模型列表；可清空业务空间 ID 后使用 DashScope 兼容端点拉取',
      )
    return openAiModelList(await request(ctx, '/compatible-mode/v1/models'))
  },
})
async function requestWithOss(ctx: Context, path: string, body: Json) {
  const wrapped: Context = {
    ...ctx,
    fetch: ((url, init) =>
      ctx.fetch(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          'X-DashScope-OssResourceResolve': 'enable',
        },
      })) as typeof fetch,
  }
  return request(wrapped, path, body, true)
}
export const bailianPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'aliyun/bailian',
      version: '0.1.0',
      name: '阿里云百炼',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['aliyun/bailian'] },
      permissions: {
        secrets: ['DASHSCOPE_API_KEY'],
        assets: 'read',
        network: [
          'dashscope.aliyuncs.com',
          'dashscope-intl.aliyuncs.com',
          'dashscope-us.aliyuncs.com',
          '*.cn-beijing.maas.aliyuncs.com',
          '*.ap-southeast-1.maas.aliyuncs.com',
          '*.us-east-1.maas.aliyuncs.com',
          '*.oss-cn-shenzhen.aliyuncs.com',
          '*.oss-cn-beijing.aliyuncs.com',
          '*.oss-cn-shanghai.aliyuncs.com',
          '*.oss-cn-hangzhou.aliyuncs.com',
          '*.oss-ap-southeast-1.aliyuncs.com',
          '*.oss-us-east-1.aliyuncs.com',
          '*.oss-accelerate.aliyuncs.com',
        ],
      },
    },
  }),
  { providers: [bailianProvider] },
)

import {
  type AssetRef,
  type CapabilityInput,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  type ProviderContext,
  ProviderError,
  type ProviderOutput,
  type ProviderUsage,
} from '@plein/plugin-sdk'
import { z } from 'zod'

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
type Obj = Record<string, unknown>
function obj(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
}
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
  const data = obj(value),
    error = obj(data.error)
  const code = String(error.code ?? data.code ?? '').toLowerCase()
  const secret = ctx.secret('DASHSCOPE_API_KEY')?.trim()
  let message = String(error.message ?? data.message ?? `百炼 HTTP ${status}`)
  if (secret) message = message.split(secret).join('[REDACTED]')
  message = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
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
async function response(
  ctx: Context,
  path: string,
  body?: Obj,
  asyncTask = false,
): Promise<Response> {
  try {
    const res = await ctx.fetch(host(ctx) + path, {
      method: body === undefined ? 'GET' : 'POST',
      signal: ctx.signal,
      headers: {
        Authorization: `Bearer ${key(ctx)}`,
        'Content-Type': 'application/json',
        ...(asyncTask ? { 'X-DashScope-Async': 'enable' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!res.ok) {
      let data: unknown
      try {
        data = await res.json()
      } catch {
        data = {}
      }
      throw remoteError(res.status, data, ctx)
    }
    return res
  } catch (e) {
    if (e instanceof ProviderError) throw e
    throw new ProviderError(
      ctx.signal.aborted
        ? 'cancelled'
        : e instanceof Error && e.name === 'TimeoutError'
          ? 'timeout'
          : 'unavailable',
      body === undefined
        ? '百炼请求中断或网络不可用'
        : '百炼提交状态未知；请先恢复查询，勿重新生成',
      { retryable: body === undefined, cause: e },
    )
  }
}
async function request(ctx: Context, path: string, body?: Obj, asyncTask = false): Promise<Obj> {
  const res = await response(ctx, path, body, asyncTask)
  let value: unknown
  try {
    value = await res.json()
  } catch (e) {
    throw new ProviderError('unknown', '百炼返回无效 JSON；请勿自动重新提交生成任务', { cause: e })
  }
  const data = obj(value)
  if (Object.keys(data).length === 0) throw new ProviderError('unknown', '百炼返回空响应')
  if (data.code || data.error) throw remoteError(res.status, data, ctx)
  return data
}
function usage(data: Obj): ProviderUsage {
  const u = obj(data.usage)
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
async function inline(ref: AssetRef, ctx: Context) {
  const { data, mime } = await ctx.files.read(ref)
  if (!mime.startsWith('image/')) throw new ProviderError('invalid_input', '参考资产必须是图片')
  if (data.length > 10 * 1024 * 1024) throw new ProviderError('invalid_input', '参考图片超过 10 MB')
  return `data:${mime};base64,${Buffer.from(data).toString('base64')}`
}
async function upload(ref: AssetRef, model: string, ctx: Context) {
  const { data, mime } = await ctx.files.read(ref)
  const ext = (
    {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/bmp': 'bmp',
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
  const policy = obj(
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
  'video.generate': ['wan3.0-video', 'wan3.0-video-prime'],
  'audio.speech': ['qwen3-tts-flash', 'qwen3-tts-instruct-flash'],
}
const IMAGE_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4']

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
    ...['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash'].map((id) => ({
      id,
      title: id,
      capabilities: ['text.chat' as const],
    })),
    ...['qwen-image-3.0-pro', 'qwen-image-3.0'].map((id) => ({
      id,
      title: id,
      capabilities: ['image.generate' as const],
      limits: { aspectRatios: IMAGE_ASPECTS, references: { max: 3 } },
      options: z.object({
        negative_prompt: z
          .string()
          .optional()
          .meta({ title: '反向提示词', placeholder: '不希望出现的内容' }),
        watermark: z.boolean().optional().meta({ title: '水印' }),
      }),
    })),
    {
      id: 'wan2.7-image-pro',
      title: 'wan2.7-image-pro',
      capabilities: ['image.generate' as const],
      limits: { aspectRatios: IMAGE_ASPECTS },
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
        watermark: z.boolean().optional().meta({ title: '水印' }),
      }),
    },
    ...['wan3.0-video', 'wan3.0-video-prime'].map((id) => ({
      id,
      title: id,
      capabilities: ['video.generate' as const],
      limits: {
        resolutions: ['480P', '720P', '1080P'],
        duration: { min: 2, max: 30 },
        references: { max: 10 },
      },
      options: z.object({
        audio: z
          .boolean()
          .optional()
          .meta({ title: '生成音频', description: '默认开启，同时生成环境音和对白' }),
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
      limits: { speed: false as const, instruction: false },
    },
    {
      id: 'qwen3-tts-instruct-flash',
      title: 'qwen3-tts-instruct-flash',
      capabilities: ['audio.speech' as const],
      // 语速用语气指令描述
      limits: { speed: false as const },
    },
  ],
  async test(ctx) {
    key(ctx)
    ctx.log('本地密钥配置已填写；未验证网络、鉴权、模型权限或余额，未调用计费接口')
  },
  async submit(req, ctx) {
    key(ctx)
    if (!supported[req.capability]?.includes(req.model))
      throw new ProviderError('invalid_input', `百炼模型 ${req.model} 不支持 ${req.capability}`)
    switch (req.capability) {
      case 'text.chat': {
        const input = req.input as CapabilityInput<'text.chat'>
        const messages = await Promise.all(
          input.messages.map(async (m) => ({
            role: m.role,
            content:
              typeof m.content === 'string'
                ? m.content
                : await Promise.all(
                    m.content.map(async (p) =>
                      p.type === 'text'
                        ? p
                        : { type: 'image_url', image_url: { url: await inline(p.image, ctx) } },
                    ),
                  ),
          })),
        )
        if (input.jsonSchema)
          messages.unshift({
            role: 'system',
            content: `Return only JSON matching this schema: ${JSON.stringify(input.jsonSchema)}`,
          })
        const res = await response(ctx, '/compatible-mode/v1/chat/completions', {
          ...input.extra,
          model: req.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          ...(input.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
        })
        let raw: string
        try {
          raw = await res.text()
        } catch (e) {
          throw new ProviderError(
            ctx.signal.aborted ? 'cancelled' : 'unavailable',
            '百炼流式响应中断；勿重新生成',
            { retryable: false, cause: e },
          )
        }
        let text = '',
          done = false,
          data: Obj = {}
        for (const frame of raw.split(/\r?\n\r?\n/)) {
          const payload = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
          if (!payload) continue
          if (payload === '[DONE]') {
            done = true
            break
          }
          let chunk: Obj
          try {
            chunk = obj(JSON.parse(payload))
          } catch {
            throw new ProviderError('unknown', '百炼返回无效 SSE 数据')
          }
          if (chunk.error || chunk.code) throw remoteError(200, chunk, ctx)
          if (chunk.usage) data = chunk
          for (const choice of arr(chunk.choices)) {
            const content = obj(obj(choice).delta).content
            if (typeof content === 'string') text += content
          }
        }
        if (!done || !text)
          throw new ProviderError('unknown', '百炼回答不完整或未收到 [DONE]；请勿自动重新提交')
        let outputs: ProviderOutput[] = [{ type: 'text', text }]
        if (input.jsonSchema) {
          try {
            outputs = [{ type: 'json', value: JSON.parse(text) }]
          } catch {
            throw new ProviderError('unknown', '模型回答不是有效 JSON')
          }
        }
        return { state: 'succeeded', outputs, usage: usage(data) }
      }
      case 'image.generate': {
        const input = req.input as CapabilityInput<'image.generate'>
        if (!input.prompt.trim()) throw new ProviderError('invalid_input', '图片提示词不能为空')
        if ((input.width === undefined) !== (input.height === undefined))
          throw new ProviderError('invalid_input', '图片宽高须一起填写')
        if (req.model.startsWith('qwen-image-3.0') && (input.references?.length ?? 0) > 3)
          throw new ProviderError('invalid_input', 'Qwen Image 3.0 最多支持 3 张参考图')
        const extra = Object.fromEntries(
          Object.entries(input.extra ?? {}).filter(
            ([k]) =>
              [
                'size',
                'n',
                'seed',
                'watermark',
                'negative_prompt',
                'prompt_extend',
                'enable_sequential',
                'thinking_mode',
              ].includes(k) &&
              (!req.model.startsWith('qwen-image-3.0') ||
                ['size', 'n', 'seed', 'watermark', 'negative_prompt'].includes(k)),
          ),
        )
        const ratios: Record<string, string> = {
          '16:9': '1664*936',
          '9:16': '936*1664',
          '1:1': '1024*1024',
          '4:3': '1536*1152',
          '3:4': '1152*1536',
        }
        const aspect =
          typeof input.extra?.aspectRatio === 'string' ? input.extra.aspectRatio : '16:9'
        if (!extra.size && !input.width && !ratios[aspect])
          throw new ProviderError('invalid_input', `不支持图片比例：${aspect}`)
        const size =
          extra.size ??
          (input.width && input.height ? `${input.width}*${input.height}` : ratios[aspect])
        const content: Obj[] = [{ text: input.prompt }]
        for (const ref of input.references ?? []) content.push({ image: await inline(ref, ctx) })
        const data = await request(ctx, generation, {
          model: req.model,
          input: { messages: [{ role: 'user', content }] },
          parameters: {
            watermark: false,
            ...extra,
            size,
            ...(input.count !== undefined ? { n: input.count } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
          },
        })
        const outputs = arr(obj(data.output).choices)
          .flatMap((c) => arr(obj(obj(c).message).content))
          .map(obj)
          .filter((p) => p.image)
          .map((p) => file('image', p.image))
        if (!outputs.length) throw new ProviderError('unknown', '百炼没有返回生成图片')
        return { state: 'succeeded', outputs, usage: usage(data) }
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
        const media: Obj[] = []
        if (input.firstFrame)
          media.push({ type: 'first_frame', url: await upload(input.firstFrame, req.model, ctx) })
        if (input.lastFrame)
          media.push({ type: 'last_frame', url: await upload(input.lastFrame, req.model, ctx) })
        for (const ref of input.references ?? []) {
          if (!['image', 'audio', 'video'].includes(ref.kind))
            throw new ProviderError('invalid_input', '视频参考素材须为图片、音频或视频')
          media.push({ type: `reference_${ref.kind}`, url: await upload(ref, req.model, ctx) })
        }
        // OSS resolution is mandatory for uploaded assets; use the same scoped fetch.
        const body = {
          model: req.model,
          input: { prompt: input.prompt, ...(media.length ? { media } : {}) },
          parameters: {
            resolution: input.resolution ?? '720P',
            ratio: input.aspectRatio ?? '16:9',
            audio: true,
            watermark: false,
            ...input.extra,
            ...(input.duration !== undefined ? { duration: input.duration } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
          },
        }
        const path = '/api/v1/services/aigc/video-generation/video-synthesis'
        const data = media.length
          ? await requestWithOss(ctx, path, body)
          : await request(ctx, path, body, true)
        const output = obj(data.output)
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
        if (!input.text.trim() || [...input.text].length > 600)
          throw new ProviderError('invalid_input', '千问语音文本须为 1–600 字符')
        if (input.instruction && !req.model.includes('instruct'))
          throw new ProviderError('invalid_input', '语音指令需要 qwen3-tts-instruct-flash')
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
            ...(input.instruction
              ? { instructions: input.instruction, optimize_instructions: true }
              : {}),
          },
        })
        return {
          state: 'succeeded',
          outputs: [file('audio', obj(obj(data.output).audio).url)],
          usage: usage(data),
        }
      }
      default:
        throw new ProviderError('invalid_input', `百炼暂不支持 ${req.capability}`)
    }
  },
  async poll(remoteId, ctx) {
    const data = await request(ctx, `/api/v1/tasks/${encodeURIComponent(remoteId)}`)
    const output = obj(data.output),
      status = output.task_status
    if (status === 'PENDING' || status === 'RUNNING')
      return { state: 'pending', pollAfterMs: ctx.settings.pollIntervalMs }
    if (status === 'SUCCEEDED')
      return {
        state: 'succeeded',
        outputs: [file('video', output.video_url ?? obj(output.results).video_url)],
        usage: usage(data),
      }
    if (status === 'CANCELED' || status === 'CANCELLED')
      return { state: 'failed', error: { code: 'cancelled', message: '百炼任务已取消' } }
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
    const output = obj(data.output)
    if (
      output.code ||
      (output.task_status && !['CANCELED', 'CANCELLED'].includes(String(output.task_status)))
    )
      throw remoteError(400, output, ctx)
  },
})
async function requestWithOss(ctx: Context, path: string, body: Obj) {
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

import { createOpenAI } from '@ai-sdk/openai'
import {
  type AssetRef,
  type CapabilityInput,
  type ModelSpec,
  type ProviderContext,
  type ProviderErrorCode,
  type SubmitResult,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  ProviderError,
} from '@plein/plugin-sdk'
import sharp from 'sharp'
import { z } from 'zod'
import {
  asJson,
  imageDataUrl,
  readJson,
  redact,
  send,
  withRetry,
  type Method,
} from '../shared/http'
import { chatCompletion } from '../shared/llm'
import { openAiModelList } from '../shared/model-list'

const BASE = 'https://api.openai.com/v1'
const settings = z.object({})
type Context = ProviderContext<z.output<typeof settings>>
const imageOptions = z.object({
  quality: z
    .enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .meta({ title: '画质' }),
  background: z.enum(['auto', 'opaque', 'transparent']).optional().meta({ title: '背景' }),
  output_format: z.enum(['png', 'jpeg', 'webp']).optional().meta({ title: '输出格式' }),
})
const models: ModelSpec[] = [
  // 推理模型不支持普通温度采样：声明 temperature: false，表单隐藏温度、执行时不发送
  ...['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna'].map((id): ModelSpec => ({
    id,
    title: id,
    capabilities: ['text.chat'],
    features: ['vision', 'tools'],
    limits: { temperature: false },
    options: z.object({
      reasoning_effort: z.enum(['low', 'medium', 'high']).optional().meta({ title: '思考强度' }),
    }),
  })),
  ...['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].map((id): ModelSpec => ({
    id,
    title: id,
    capabilities: ['image.generate', 'image.edit'],
    options: imageOptions,
    description: '支持多参考图与蒙版引导编辑；蒙版边界不保证像素级保留。',
    limits: {
      promptMaxLength: 32000,
      aspectRatios: ['1:1', '3:2', '2:3', '16:9', '9:16'],
      count: { max: 10 },
      references: { max: 16 },
      seed: false,
    },
  })),
]
const messages = {
  cancelled: 'OpenAI 请求已取消；生成提交可能已受理',
  network: 'OpenAI 网络请求失败；生成提交结果未知，请勿直接重提',
}
function key(ctx: Context) {
  const value = ctx.secret('OPENAI_API_KEY')?.trim()
  if (!value) throw new ProviderError('auth', '请填写 OpenAI API Key')
  return value
}
function remoteError(ctx: Context, status: number, value: unknown, method: Method) {
  const error = asJson(asJson(value).error)
  const code = String(error.code ?? error.type ?? '').toLowerCase()
  const category: ProviderErrorCode = /quota|billing|insufficient/.test(code)
    ? 'quota'
    : status === 401 || status === 403
      ? 'auth'
      : /content_policy|safety|moderation/.test(code)
        ? 'content_policy'
        : status === 429
          ? 'rate_limit'
          : status === 408 || status === 504
            ? 'timeout'
            : status >= 500
              ? 'unavailable'
              : status >= 400
                ? 'invalid_input'
                : 'unknown'
  return withRetry(
    new ProviderError(
      category,
      redact(
        String(error.message ?? `OpenAI HTTP ${status}`),
        [ctx.secret('OPENAI_API_KEY'), ctx.secret('OPENAI_API_KEY')?.trim()],
        { tokens: true },
      ),
    ),
    method,
    status,
  )
}
async function request(ctx: Context, path: string, body?: Record<string, unknown>) {
  const method = body ? 'POST' : 'GET'
  const res = await send(
    ctx,
    `${BASE}${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${key(ctx)}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    messages,
  )
  const value = await readJson(ctx, res, method, messages)
  if (!res.ok || asJson(value).error) throw remoteError(ctx, res.status, value, method)
  return asJson(value)
}
function imageURL(ctx: Context, ref: AssetRef) {
  return imageDataUrl(ctx, ref, {
    accept: (mime) => ['image/png', 'image/jpeg', 'image/webp'].includes(mime),
    maxBytes: 14 * 1024 * 1024,
    notImage: 'OpenAI 只接受图片资产',
    badMime: 'OpenAI 图片须为 PNG、JPEG 或 WebP',
    tooLarge: 'OpenAI 图片为空或超过本地 14 MiB 限制',
  })
}
/** 不能把截断的 Responses SSE 当作成功；SDK 负责解释终包里的业务状态。 */
function terminalResponse(res: Response) {
  if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return res
  const decoder = new TextDecoder()
  let pending = '',
    terminal = false
  const body = res.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const item = JSON.parse(line.slice(5))
            if (
              ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(
                item.type,
              )
            )
              terminal = true
          } catch {
            /* SDK reports malformed events. */
          }
        }
        controller.enqueue(chunk)
      },
      flush(controller) {
        if (!terminal)
          controller.error(
            new ProviderError('unknown', 'OpenAI 回答不完整，未收到结束事件；请勿直接重提', {
              outcome: 'unknown',
              retryable: false,
            }),
          )
      },
    }),
  )
  return new Response(body, { status: res.status, headers: res.headers })
}
function imageSize(input: CapabilityInput<'image.generate'>) {
  if (input.width !== undefined || input.height !== undefined) {
    const w = input.width ?? 0,
      h = input.height ?? 0
    if (
      ![w, h].every((n) => Number.isInteger(n) && n > 0 && n <= 3840 && n % 16 === 0) ||
      w * h < 655360 ||
      w * h > 8294400 ||
      w / h < 1 / 3 ||
      w / h > 3
    )
      throw new ProviderError(
        'invalid_input',
        'OpenAI 尺寸须为 16 的倍数、每边不超过 3840、总像素 655360–8294400、比例 1:3–3:1',
      )
    return `${w}x${h}`
  }
  const sizes: Record<string, string> = {
    '1:1': '1024x1024',
    '3:2': '1536x1024',
    '2:3': '1024x1536',
    '16:9': '1536x864',
    '9:16': '864x1536',
  }
  const ratio = String(input.extra?.aspectRatio ?? 'auto')
  if (ratio !== 'auto' && !sizes[ratio])
    throw new ProviderError('invalid_input', 'OpenAI 不支持所选画幅')
  return sizes[ratio] ?? 'auto'
}
async function image(
  req: Parameters<typeof openaiProvider.submit>[0],
  ctx: Context,
): Promise<SubmitResult> {
  const input = req.input as CapabilityInput<'image.generate'> &
    Partial<CapabilityInput<'image.edit'>>
  const options = imageOptions.safeParse(input.extra ?? {})
  if (!options.success) throw new ProviderError('invalid_input', 'OpenAI 图片参数无效')
  const format = options.data.output_format ?? 'png'
  if (format === 'jpeg' && options.data.background === 'transparent')
    throw new ProviderError('invalid_input', '透明背景须使用 PNG 或 WebP')
  const count = input.count ?? 1
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 10 ||
    !input.prompt?.trim() ||
    input.prompt.length > 32000
  )
    throw new ProviderError('invalid_input', 'OpenAI 图片提示词须为 1–32000 字符，数量须为 1–10')
  const body: Record<string, unknown> = {
    ...options.data,
    model: req.model,
    prompt: input.prompt,
    n: count,
    output_format: format,
  }
  let edit = req.capability === 'image.edit'
  if (edit) {
    if (!input.image || !input.mask) throw new ProviderError('invalid_input', '请提供原图和蒙版')
    const source = await ctx.files.read(input.image),
      mask = await ctx.files.read(input.mask)
    if (source.data.length > 14 * 1024 * 1024 || mask.data.length > 14 * 1024 * 1024)
      throw new ProviderError('invalid_input', '原图或蒙版超过本地 14 MiB 限制')
    try {
      const original = await sharp(source.data).rotate().png().toBuffer({ resolveWithObject: true })
      const gray = await sharp(mask.data)
        .removeAlpha()
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true })
      if (original.info.width !== gray.info.width || original.info.height !== gray.info.height)
        throw new Error('dimensions')
      // Plein 白色重画，OpenAI 透明重画：反转亮度成为 alpha。
      const alpha = Buffer.from(gray.data.map((v) => 255 - v))
      const converted = await sharp({
        create: {
          width: gray.info.width,
          height: gray.info.height,
          channels: 3,
          background: 'white',
        },
      })
        .joinChannel(alpha, {
          raw: { width: gray.info.width, height: gray.info.height, channels: 1 },
        })
        .png()
        .toBuffer()
      const dataURL = (data: Uint8Array) =>
        `data:image/png;base64,${Buffer.from(data).toString('base64')}`
      if (Math.max(original.data.length, converted.length) > 14 * 1024 * 1024)
        throw new Error('size')
      body.images = [{ image_url: dataURL(original.data) }]
      body.mask = { image_url: dataURL(converted) }
    } catch (cause) {
      throw new ProviderError(
        'invalid_input',
        'OpenAI 原图或蒙版无法读取、尺寸不一致或转换后过大',
        { cause },
      )
    }
  } else {
    body.size = imageSize(input)
    if ((input.references?.length ?? 0) > 16)
      throw new ProviderError('invalid_input', 'OpenAI 最多支持 16 张参考图')
    if (input.references?.length) {
      edit = true
      body.images = await Promise.all(
        input.references.map(async (ref) => ({ image_url: await imageURL(ctx, ref) })),
      )
    }
  }
  const result = await request(ctx, edit ? '/images/edits' : '/images/generations', body)
  const items = z
    .array(z.object({ b64_json: z.string().min(1) }))
    .min(1)
    .safeParse(result.data)
  if (
    !items.success ||
    items.data.some(
      (p) => !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.b64_json),
    )
  )
    throw new ProviderError('unknown', 'OpenAI 图片响应无效，提交可能已计费，请勿直接重提', {
      outcome: 'unknown',
      retryable: false,
    })
  return {
    state: 'succeeded',
    outputs: items.data.map((item) => ({
      type: 'file',
      kind: 'image',
      mime: `image/${format}`,
      data: Buffer.from(item.b64_json, 'base64'),
    })),
    usage: { images: items.data.length },
  }
}

export const openaiProvider = defineProvider({
  id: 'openai/api',
  title: 'OpenAI',
  description: 'OpenAI 官方 API：对话、内置 Agent、图片生成与蒙版编辑。',
  docsUrl: 'https://developers.openai.com/api/docs',
  settings,
  secrets: [{ name: 'OPENAI_API_KEY', title: 'API Key', required: true }],
  models,
  // /models 不提供接口与能力信息，目录外条目仅展示，不自动当作对话模型提交。
  remoteModelsScope: [],
  async listRemoteModels(ctx) {
    return openAiModelList(await request(ctx, '/models'))
  },
  async test(ctx) {
    await request(ctx, '/models')
  },
  async submit(req, ctx): Promise<SubmitResult> {
    const model = models.find((m) => m.id === req.model)
    if (!model?.capabilities.includes(req.capability))
      throw new ProviderError('invalid_input', 'OpenAI 模型不支持该能力，请重新选择模型')
    if (req.capability !== 'text.chat') return image(req, ctx)
    const input = req.input as CapabilityInput<'text.chat'>
    const api = createOpenAI({
      apiKey: key(ctx),
      baseURL: BASE,
      fetch: async (url, init) => {
        if (String(url) !== `${BASE}/responses`)
          throw new ProviderError('invalid_input', 'OpenAI 请求地址无效')
        const res = await send(
          ctx,
          String(url),
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${key(ctx)}`, 'Content-Type': 'application/json' },
            body: String(init?.body),
          },
          messages,
        )
        if (!res.ok)
          throw remoteError(ctx, res.status, await readJson(ctx, res, 'POST', messages), 'POST')
        return terminalResponse(res)
      },
    })
    const effort = asJson(input.extra).reasoning_effort
    if (effort !== undefined && !['low', 'medium', 'high'].includes(String(effort)))
      throw new ProviderError('invalid_input', 'OpenAI 思考强度无效')
    return chatCompletion({
      ctx,
      label: 'OpenAI',
      baseURL: BASE,
      model: req.model,
      languageModel: api.responses(req.model),
      openaiResponses: true,
      // 推理模型不支持普通温度采样；不发送节点默认 temperature。
      input: { ...input, temperature: undefined },
      structured: 'json_schema',
      image: (ref) => imageURL(ctx, ref),
      providerOptions: {
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          ...(effort ? { reasoningEffort: String(effort) } : {}),
        },
      },
      fetch: ctx.fetch,
      streamError: (error) => remoteError(ctx, 200, { error }, 'POST'),
    })
  },
})
export const openaiPlugin = defineServerPlugin(
  definePlugin({
    manifest: {
      id: 'openai/api',
      version: PLUGIN_API_VERSION,
      name: 'OpenAI',
      engines: { plein: `^${PLUGIN_API_VERSION}` },
      contributes: { providers: ['openai/api'] },
      permissions: { network: ['api.openai.com'], secrets: ['OPENAI_API_KEY'], assets: 'read' },
    },
  }),
  { providers: [openaiProvider] },
)

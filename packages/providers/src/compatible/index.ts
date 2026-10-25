import { createHash } from 'node:crypto'
import {
  type CapabilityInput,
  definePlugin,
  defineProvider,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  type ProviderContext,
  ProviderError,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { asJson, imageDataUrl, readJson, redact, send, withRetry } from '../shared/http'
import { chatCompletion, requireSseDone } from '../shared/llm'

export const COMPATIBLE_ID = 'plein/compatible'

/** A single explicit channel. No model discovery or inferred capabilities. */
export const compatibleSettings = z
  .object({
    baseURL: z
      .string()
      .trim()
      .default('')
      .meta({ title: 'Base URL', description: '包含 /v1 等协议前缀；HTTPS 或本机 localhost HTTP' }),
    model: z.string().trim().max(200).default('').meta({
      title: '模型 ID',
      description: '填写渠道上的实际模型 ID；修改渠道后需要重新选择模型',
    }),
    vision: z.boolean().default(false).meta({ title: '支持图片输入' }),
    tools: z.boolean().default(false).meta({ title: '支持工具调用' }),
    structured: z
      .enum(['none', 'json_object', 'json_schema'])
      .default('none')
      .meta({ title: '结构化输出', description: '仅按渠道实际支持的协议选择；不会根据模型名推断' }),
  })
  .superRefine((value, ctx) => {
    if (!value.baseURL) return
    try {
      compatibleBaseURL(value.baseURL)
    } catch (error) {
      ctx.addIssue({ code: 'custom', path: ['baseURL'], message: (error as Error).message })
    }
  })

export function compatibleBaseURL(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Base URL 必须是完整的 HTTP(S) 地址')
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Base URL 不能包含用户名、密码、查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost'))
    throw new Error('远端渠道必须使用 HTTPS；HTTP 仅支持 localhost')
  if (!/^(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,})$/.test(url.hostname))
    throw new Error('渠道地址须使用域名或 localhost')
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

type Settings = z.output<typeof compatibleSettings>
type Context = ProviderContext<Settings>

function identity(settings: Settings): string {
  const url = compatibleBaseURL(settings.baseURL)
  const normalized = { ...settings, baseURL: url.href.replace(/\/$/, '') }
  return `chat-${createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24)}`
}

function validate(settings: Settings) {
  if (!settings.baseURL || !settings.model)
    throw new ProviderError('invalid_input', '请填写渠道 Base URL 与实际模型 ID')
  compatibleBaseURL(settings.baseURL)
}

function remoteError(status: number, value: unknown, ctx: Context) {
  const data = asJson(value),
    error = asJson(data.error)
  const code = String(error.code ?? data.code ?? '').toLowerCase()
  const message = redact(
    String(error.message ?? data.message ?? `兼容渠道 HTTP ${status}`),
    [ctx.secret('COMPATIBLE_API_KEY'), ctx.secret('COMPATIBLE_API_KEY')?.trim()],
    { tokens: true },
  )
  const normalized =
    status === 401 || status === 403
      ? 'auth'
      : /quota|insufficient|balance/.test(code)
        ? 'quota'
        : /content|safety|policy/.test(code)
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
  return withRetry(new ProviderError(normalized, message), 'POST', status)
}

/** Rebuild only this built-in descriptor after configuration changes. Old refs stop being selectable. */
export function createCompatiblePlugin(raw: Record<string, unknown> = {}) {
  const parsed = compatibleSettings.safeParse(raw)
  const configured = parsed.success && !!parsed.data.baseURL && !!parsed.data.model
  const config = parsed.success ? parsed.data : compatibleSettings.parse({})
  const modelId = configured ? identity(config) : ''
  const provider = defineProvider({
    id: COMPATIBLE_ID,
    title: '兼容对话渠道',
    description:
      '单个自定义 Chat Completions 渠道；能力由你明确指定。更改地址、模型或能力后需重新选择模型。',
    settings: compatibleSettings,
    secrets: [{ name: 'COMPATIBLE_API_KEY', title: 'API Key', required: true }],
    models: modelId
      ? [
          {
            id: modelId,
            title: config.model,
            capabilities: ['text.chat'],
            features: [
              ...(config.vision ? ['vision' as const] : []),
              ...(config.tools ? ['tools' as const] : []),
            ],
            version: modelId,
          },
        ]
      : [],
    testScope: 'configuration',
    async test(ctx) {
      validate(ctx.settings)
      if (!ctx.secret('COMPATIBLE_API_KEY')?.trim())
        throw new ProviderError('auth', '请填写 API Key')
      ctx.log('仅检查本地配置；未验证网络、鉴权、模型能力或余额，未调用计费接口')
    },
    async submit(req, ctx) {
      validate(ctx.settings)
      if (req.capability !== 'text.chat' || req.model !== identity(ctx.settings))
        throw new ProviderError('invalid_input', '渠道配置已变化或模型不支持该能力，请重新选择模型')
      const input = req.input as CapabilityInput<'text.chat'>
      if (
        !ctx.settings.vision &&
        input.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'),
        )
      )
        throw new ProviderError('invalid_input', '该渠道未声明支持图片输入')
      if (
        !ctx.settings.tools &&
        (input.tools?.length ||
          input.messages.some((m) => m.role === 'tool' || m.toolCalls?.length))
      )
        throw new ProviderError('invalid_input', '该渠道未声明支持工具调用')
      if (input.jsonSchema && ctx.settings.structured === 'none')
        throw new ProviderError('invalid_input', '该渠道未声明支持结构化输出')
      const base = compatibleBaseURL(ctx.settings.baseURL).href.replace(/\/$/, '')
      const key = ctx.secret('COMPATIBLE_API_KEY')?.trim()
      if (!key) throw new ProviderError('auth', '请填写 API Key')
      const messages = {
        cancelled: '兼容渠道提交可能已受理，请勿直接重提',
        network: '兼容渠道提交状态未知，请勿直接重提',
      }
      return chatCompletion({
        ctx,
        label: '兼容渠道',
        baseURL: base,
        model: ctx.settings.model,
        input,
        structured: ctx.settings.structured === 'json_schema' ? 'json_schema' : 'json_object',
        image: (ref) =>
          imageDataUrl(ctx, ref, {
            accept: (mime) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime),
            maxBytes: 20 * 1024 * 1024,
            notImage: '兼容渠道只接受图片资产',
            badMime: '兼容渠道图片须为 PNG、JPEG、WebP 或 GIF',
            tooLarge: '兼容渠道图片为空或超过 20 MiB',
          }),
        streamError: (error) => remoteError(200, { error }, ctx),
        fetch: async (url, init) => {
          if (String(url) !== `${base}/chat/completions`)
            throw new ProviderError('invalid_input', '兼容渠道请求地址与配置不一致')
          const res = await send(
            ctx,
            String(url),
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: String(init?.body),
            },
            messages,
          )
          if (!res.ok)
            throw remoteError(res.status, await readJson(ctx, res, 'POST', messages), ctx)
          return requireSseDone(
            res,
            () =>
              new ProviderError('unknown', '兼容渠道回答不完整，未收到 [DONE]；请勿直接重提', {
                outcome: 'unknown',
              }),
          )
        },
      })
    },
  })
  return defineServerPlugin(
    definePlugin({
      manifest: {
        id: COMPATIBLE_ID,
        version: PLUGIN_API_VERSION,
        name: '兼容对话渠道',
        engines: { plein: `^${PLUGIN_API_VERSION}` },
        contributes: { providers: [COMPATIBLE_ID] },
        permissions: {
          network: configured ? [compatibleBaseURL(config.baseURL).hostname] : [],
          secrets: ['COMPATIBLE_API_KEY'],
          assets: 'read',
        },
      },
    }),
    { providers: [provider] },
  )
}

export const compatiblePlugin = createCompatiblePlugin()

import { createHash } from 'node:crypto'
import {
  compatibleBaseURL,
  createOpenAICompatibleAdapter,
  models as openaiModels,
} from 'modelbay/openai'
import {
  type CapabilityInput,
  definePlugin,
  defineServerPlugin,
  PLUGIN_API_VERSION,
  ProviderError,
} from '@plein/plugin-sdk'
import { z } from 'zod'
import { adapterToProvider, toAdapterContext } from '../bridge'

export { compatibleBaseURL }

export const COMPATIBLE_ID = 'plein/compatible'

/** 请求构造、流式与 [DONE] 校验、错误归类都在 modelbay；这里只留宿主侧的设置、身份与能力闸。 */
const adapter = createOpenAICompatibleAdapter(openaiModels)

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
      // 渲染时接 datalist，候选来自渠道的 /models（见设置页的模型候选区域）
      list: 'compatible-model-ids',
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

type Settings = z.output<typeof compatibleSettings>

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

/** Rebuild only this built-in descriptor after configuration changes. Old refs stop being selectable. */
export function createCompatiblePlugin(raw: Record<string, unknown> = {}) {
  const parsed = compatibleSettings.safeParse(raw)
  const configured = parsed.success && !!parsed.data.baseURL && !!parsed.data.model
  const config = parsed.success ? parsed.data : compatibleSettings.parse({})
  const modelId = configured ? identity(config) : ''
  const provider = adapterToProvider(adapter, {
    id: COMPATIBLE_ID,
    title: '兼容对话渠道',
    channel: 'openai-compatible',
    poll: false,
    // 适配器会探测 OPENAI_COMPATIBLE_API_KEY 等 MCP / CLI 用的别名，宿主沙箱只认清单声明的
    declaredSecretsOnly: true,
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
              ...(config.structured !== 'none' ? ['structured' as const] : []),
            ],
            version: modelId,
          },
        ]
      : [],
    testScope: 'configuration',
    // 渠道列表只作设置里「模型 ID」的候选：内置项是配置本身，不参与可用性标记与 remote-only 提交
    remoteModelsScope: [],
    // Base URL 决定列表内容，参与缓存键
    remoteModelsSettings: ['baseURL'],
    async test(ctx) {
      validate(ctx.settings)
      if (!ctx.secret('COMPATIBLE_API_KEY')?.trim())
        throw new ProviderError('auth', '请填写 API Key')
      ctx.log('仅检查本地配置；未验证网络、鉴权、模型能力或余额，未调用计费接口')
    },
    // 渠道上的模型都是对话模型；拉取候选只需要 Base URL 与 API Key，模型 ID 只在提交时必填
    async listRemoteModels(ctx) {
      if (!ctx.settings.baseURL)
        throw new ProviderError('invalid_input', '请先填写渠道 Base URL，再拉取模型候选')
      return (await adapter.native!('listModels', {}, toAdapterContext(ctx))) as never
    },
    async beforeSubmit(req, ctx) {
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
      if (!ctx.secret('COMPATIBLE_API_KEY')?.trim())
        throw new ProviderError('auth', '请填写 API Key')
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

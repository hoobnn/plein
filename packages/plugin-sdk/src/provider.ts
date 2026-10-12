import { z } from 'zod'
import { NAMESPACED_ID } from './ids'
import type { AssetRef } from './ports'

/** 模型能力。节点按能力选模型，Provider 声明每个模型支持哪些能力 */
export const Capability = z.enum([
  'text.chat',
  'image.generate',
  'video.generate',
  'audio.speech',
  'audio.music',
  'audio.sfx',
  'audio.transcribe',
])
export type Capability = z.infer<typeof Capability>

// ── 各能力的输入（归一化后的公共字段；平台特有参数放 extra） ─────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /** 文本，或文本与图片混排 */
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; image: AssetRef }>
}

export interface CapabilityInputs {
  'text.chat': {
    messages: ChatMessage[]
    /** 要求按 JSON Schema 输出结构化结果 */
    jsonSchema?: Record<string, unknown>
    temperature?: number
    maxTokens?: number
  }
  'image.generate': {
    prompt: string
    negativePrompt?: string
    /** 参考图（图生图 / 多参考图） */
    references?: AssetRef[]
    width?: number
    height?: number
    count?: number
    seed?: number
  }
  'video.generate': {
    prompt: string
    firstFrame?: AssetRef
    lastFrame?: AssetRef
    references?: AssetRef[]
    /** 秒 */
    duration?: number
    aspectRatio?: string
    resolution?: string
    seed?: number
  }
  'audio.speech': {
    text: string
    voice?: string
    /** 情绪、语气等自然语言指令 */
    instruction?: string
    speed?: number
  }
  'audio.music': { prompt: string; duration?: number }
  'audio.sfx': { prompt: string; duration?: number }
  'audio.transcribe': { audio: AssetRef; language?: string }
}

export type CapabilityInput<C extends Capability> = CapabilityInputs[C] & {
  /** 平台特有参数，原样传给 Provider */
  extra?: Record<string, unknown>
}

/** Provider 返回的结果：文本、结构化数据或文件（宿主负责下载并存入资产库） */
export type ProviderOutput =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown }
  | {
      type: 'file'
      kind: 'image' | 'video' | 'audio'
      mime: string
      /** 远端地址（宿主会下载，需在清单 permissions.network 里声明域名）或直接给字节 */
      url?: string
      data?: Uint8Array
      name?: string
    }

export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
  /** 生成的秒数（视频、音频） */
  seconds?: number
  characters?: number
  images?: number
}

/** 提交结果：同步平台直接给结果，异步平台给远端任务 id 由宿主轮询 */
export type SubmitResult =
  | { state: 'succeeded'; outputs: ProviderOutput[]; usage?: ProviderUsage }
  | { state: 'pending'; remoteId: string; pollAfterMs?: number }

export type PollResult =
  | { state: 'pending'; progress?: number; pollAfterMs?: number }
  | { state: 'succeeded'; outputs: ProviderOutput[]; usage?: ProviderUsage }
  | { state: 'failed'; error: ProviderErrorInfo }

export const ProviderErrorCode = z.enum([
  'auth',
  'quota',
  'rate_limit',
  'invalid_input',
  'content_policy',
  'timeout',
  'unavailable',
  'cancelled',
  'unknown',
])
export type ProviderErrorCode = z.infer<typeof ProviderErrorCode>

export interface ProviderErrorInfo {
  code: ProviderErrorCode
  message: string
  retryable?: boolean
}

/** Provider 抛出的归一化错误；节点上按 code 给出可读的原因 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly retryable: boolean
  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'ProviderError'
    this.code = code
    this.retryable =
      opts.retryable ?? (code === 'rate_limit' || code === 'unavailable' || code === 'timeout')
  }
}

export interface ModelSpec {
  /** 平台上的模型 id */
  id: string
  title: string
  capabilities: Capability[]
  description?: string
}

export interface SecretSpec {
  /** 必须在插件清单 permissions.secrets 里声明 */
  name: string
  title: string
  required?: boolean
  help?: string
}

export interface ProviderRequest<C extends Capability = Capability> {
  capability: C
  model: string
  input: CapabilityInput<C>
}

/**
 * Provider 拿到的运行环境，全部由宿主按插件清单的权限裁剪过：
 * fetch 只能访问声明过的域名，secret 只能读声明过的密钥。
 */
export interface ProviderContext<S = Record<string, unknown>> {
  settings: S
  secret(name: string): string | undefined
  fetch: typeof fetch
  signal: AbortSignal
  log(message: string, data?: Record<string, unknown>): void
  files: {
    /** 读取资产内容（如把参考图转成 base64 传给平台） */
    read(ref: AssetRef): Promise<{ data: Uint8Array; mime: string }>
  }
}

/** 模型平台适配器 */
export interface ProviderDefinition<S extends z.ZodObject = z.ZodObject> {
  /** `vendor/name` */
  id: string
  title: string
  description?: string
  docsUrl?: string
  /** 非敏感配置：地域、Base URL 等；设置页按它生成表单 */
  settings: S
  secrets: SecretSpec[]
  /** 多种鉴权方式，任意一组密钥全部填写即满足条件；与 required 并用 */
  credentialAlternatives?: string[][]
  models: ModelSpec[]
  /** 宿主按它限流（同一 Provider 的并发与每分钟请求数） */
  limits?: { concurrency?: number; requestsPerMinute?: number }
  /** 无免费鉴权探针的平台仅做本地配置检查，设置页需如实提示 */
  testScope?: 'connection' | 'configuration'
  /** “测试连接”：校验密钥与网络，失败时抛 ProviderError */
  test?(ctx: ProviderContext<z.output<S>>): Promise<void>
  submit(request: ProviderRequest, ctx: ProviderContext<z.output<S>>): Promise<SubmitResult>
  poll?(remoteId: string, ctx: ProviderContext<z.output<S>>): Promise<PollResult>
  cancel?(remoteId: string, ctx: ProviderContext<z.output<S>>): Promise<void>
}

export function defineProvider<S extends z.ZodObject>(
  def: ProviderDefinition<S>,
): ProviderDefinition<S> {
  if (!NAMESPACED_ID.test(def.id)) throw new Error(`Provider id ${def.id} 应为 vendor/name`)
  const ids = new Set<string>()
  const secretNames = new Set(def.secrets.map((s) => s.name))
  if (
    def.credentialAlternatives?.some(
      (group) => group.length === 0 || group.some((name) => !secretNames.has(name)),
    )
  )
    throw new Error(`Provider ${def.id} 的鉴权组必须引用已声明的密钥且不能为空`)
  for (const m of def.models) {
    if (ids.has(m.id)) throw new Error(`Provider ${def.id} 的模型 ${m.id} 重复`)
    if (m.capabilities.length === 0) {
      throw new Error(`Provider ${def.id} 的模型 ${m.id} 没有声明能力`)
    }
    ids.add(m.id)
  }
  if (!def.settings.safeParse({}).success)
    throw new Error(`Provider ${def.id} 的设置项需要都有默认值`)
  return def
}

export function providerConfigured(
  def: ProviderDefinition,
  secrets: Record<string, string>,
): boolean {
  return (
    def.secrets.every((s) => !s.required || Boolean(secrets[s.name]?.trim())) &&
    (!def.credentialAlternatives ||
      def.credentialAlternatives.some(
        (group) => group.length > 0 && group.every((name) => Boolean(secrets[name]?.trim())),
      ))
  )
}

/** Provider 的可序列化描述，供设置页使用 */
export interface ProviderDescriptor {
  id: string
  title: string
  description?: string
  docsUrl?: string
  testScope?: 'connection' | 'configuration'
  settingsSchema: Record<string, unknown>
  secrets: SecretSpec[]
  models: ModelSpec[]
  plugin: string
}

export function describeProvider(def: ProviderDefinition, plugin: string): ProviderDescriptor {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    docsUrl: def.docsUrl,
    testScope: def.testScope,
    settingsSchema: z.toJSONSchema(def.settings, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >,
    secrets: def.secrets,
    models: def.models,
    plugin,
  }
}

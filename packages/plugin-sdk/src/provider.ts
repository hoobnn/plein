import { z } from 'zod'
import { NAMESPACED_ID } from './ids'
import type { AssetRef } from './ports'

/** 模型能力。节点按能力选模型，Provider 声明每个模型支持哪些能力 */
export const Capability = z.enum([
  'text.chat',
  'image.generate',
  'image.edit',
  'image.process',
  'video.generate',
  'audio.speech',
  'audio.music',
  'audio.sfx',
  'audio.transcribe',
])
export type Capability = z.infer<typeof Capability>

// ── 各能力的输入（归一化后的公共字段；平台特有参数放 extra） ─────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 文本，或文本与图片混排；tool 消息是工具结果的文本 */
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; image: AssetRef }>
  /** assistant：这一步模型发起的工具调用 */
  toolCalls?: ChatToolCall[]
  /** tool：回应的是哪一次调用 */
  toolCallId?: string
  /** tool：被调用的工具名 */
  toolName?: string
}

/** 模型可以调用的工具：参数用 JSON Schema 描述 */
export interface ChatTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 模型发起的一次工具调用 */
export interface ChatToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface CapabilityInputs {
  'text.chat': {
    messages: ChatMessage[]
    /** 要求按 JSON Schema 输出结构化结果 */
    jsonSchema?: Record<string, unknown>
    /** 可调用的工具（只发给声明了 tools 特性的模型）；模型要调用时输出 tool_calls */
    tools?: ChatTool[]
    toolChoice?: 'auto' | 'none' | 'required'
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
    /** 分辨率档位，取模型 `limits.resolutions` 里的值；和画幅一起换算成平台尺寸，显式宽高优先 */
    resolution?: string
    count?: number
    seed?: number
  }
  /**
   * 局部重绘：只改蒙版白色区域，其余保持原样。声明这项能力的模型必须原生支持蒙版，
   * 不能用整图重绘或裁切贴回冒充
   */
  'image.edit': {
    image: AssetRef
    /** PNG，与原图同宽高；白色 = 重绘，黑色 = 保留 */
    mask: AssetRef
    prompt: string
    count?: number
    seed?: number
  }
  'image.process': {
    image: AssetRef
    operation: 'upscale' | 'outpaint' | 'cutout'
    prompt?: string
    scale?: number
    expansion?: { top: number; bottom: number; left: number; right: number }
  }
  'video.generate': {
    prompt: string
    /** 首帧 / 尾帧与 references 互斥：各家平台都不允许混用 */
    firstFrame?: AssetRef
    lastFrame?: AssetRef
    references?: AssetRef[]
    /** 是否同时生成音频（环境音、音效、对白）；不传用平台默认 */
    audio?: boolean
    /** 秒 */
    duration?: number
    aspectRatio?: string
    /** 分辨率，取模型 `limits.resolutions` 里的值 */
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

/**
 * 语音识别的一段（秒，相对音频开头）。
 * audio.transcribe 返回全文 `{ type: 'text' }`，能给出时间戳时再加一个
 * `{ type: 'json', value: { segments: TranscriptSegment[] } }`，序列导出用它校准字幕。
 */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export type CapabilityInput<C extends Capability> = CapabilityInputs[C] & {
  /** 平台特有参数，原样传给 Provider */
  extra?: Record<string, unknown>
}

/** Provider 返回的结果：文本、结构化数据或文件（宿主负责下载并存入资产库） */
export type ProviderOutput =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown }
  /** text.chat 带 tools 时：模型要调用的工具（可能同时有一段 text） */
  | { type: 'tool_calls'; calls: ChatToolCall[] }
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
  | {
      state: 'pending'
      progress?: number
      pollAfterMs?: number
      /** 远端任务是在平台排队还是已开始生成；不给时界面只显示“平台已受理” */
      remote?: 'queued' | 'running'
    }
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
  /**
   * unknown：请求可能已经到达平台（如提交时网络断开、响应读不出来），不能当作没提交。
   * 宿主据此把提交记为「状态未知」，不自动重新提交
   */
  readonly outcome?: 'unknown'
  constructor(
    code: ProviderErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown; outcome?: 'unknown' } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'ProviderError'
    this.code = code
    if (opts.outcome) this.outcome = opts.outcome
    this.retryable =
      opts.retryable ?? (code === 'rate_limit' || code === 'unavailable' || code === 'timeout')
  }
}

/**
 * 模型对通用参数的约束。节点表单按它收窄选项、换模型时校正取值、提交前检查；
 * 没声明的项按节点自己的范围处理。
 */
export interface ModelLimits {
  /** 支持的画幅（`16:9` 这种写法） */
  aspectRatios?: string[]
  /** 可选分辨率（平台自己的写法，如 `720p`、`2K`）；不声明时不显示分辨率，用平台默认 */
  resolutions?: string[]
  /** 时长范围（秒，整数）；false 表示时长由模型决定，表单隐藏，宿主不传 */
  duration?: { min: number; max: number } | false
  /** 一次最多生成几张 */
  count?: { max: number }
  /** false 表示不支持种子，表单隐藏，宿主也不会传给 Provider */
  seed?: boolean
  /** 参考图最多几张 */
  references?: { max: number }
  /** Supported reference media for video generation; absent means images only. */
  referenceMedia?: { video: number; audio: number }
  imageOperations?: Array<'upscale' | 'outpaint' | 'cutout'>
  /** 语速范围（倍速）；false 表示不支持，表单隐藏，宿主不传 */
  speed?: { min: number; max: number } | false
  /** false 表示不支持自然语言语气指令，表单隐藏，宿主不传 */
  instruction?: boolean
  /** false 表示视频不能选择是否生成音频，表单隐藏，宿主不传 */
  audio?: boolean
}

export type ModelFeature = 'tools' | 'vision'

export interface ModelSpec {
  /** 平台上的模型 id */
  id: string
  title: string
  capabilities: Capability[]
  description?: string
  /**
   * 平台公布的模型版本（快照日期或版本号）。声明了就计入缓存键：同名模型换了权重时旧结果算过期；
   * 平台不公布时不填，模型名不等于不可变的版本
   */
  version?: string
  /** 对话模型的额外特性：tools（工具调用，内置智能体要用）、vision（看图） */
  features?: ModelFeature[]
  limits?: ModelLimits
  /** 每次提交的大致费用：影响分析据此估算重做的花费；不填算作未知 */
  price?: { amount: number; currency: string }
  /**
   * 模型专属参数（如 Seedance 的生成音频、返回尾帧）。字段名就是传给 Provider 的 `extra` 键，
   * 都应可选：用户没改的不传，平台用自己的默认值。表单在「模型专属」里按它生成。
   */
  options?: z.ZodObject
  /** 配音模型的预置音色：设定卡按角色性别、年龄从这里挑；不声明的话音色只能手填 */
  voices?: VoicePreset[]
}

/** 平台预置的一个音色 */
export interface VoicePreset {
  /** 传给平台的音色 ID */
  id: string
  title: string
  gender: 'female' | 'male'
  /** 声音年龄感：young 青年，mature 中年及以上；不填算 young */
  age?: 'young' | 'mature'
}

/** 复刻进度：训练是平台上的异步过程，宿主按 status 刷新 */
export type VoiceCloneState =
  | { status: 'training' }
  | { status: 'ready' }
  | { status: 'failed'; message: string }

/**
 * 声音复刻：上传一段样本，在平台上训练出一个只能在这家配音模型里用的音色。
 * 复刻会计费，结果是平台上的音色 ID，不是文件，所以不走模型能力。
 */
export interface VoiceCloneSpec<Ctx> {
  /**
   * 音色 ID 由谁定：slot 要用户填在平台控制台预先开通的音色槽位（如豆包的 S_ 开头 ID），
   * generated 由宿主生成一个新 ID
   */
  voiceId: 'slot' | 'generated'
  /** 样本要求，表单里给用户看 */
  hint: string
  clone(input: { voiceId: string; sample: AssetRef }, ctx: Ctx): Promise<VoiceCloneState>
  /** 查训练状态；clone 直接返回 ready / failed 的平台可以不实现 */
  status?(voiceId: string, ctx: Ctx): Promise<VoiceCloneState>
}

/** 可序列化的模型描述：专属参数转成 JSON Schema */
export type ModelInfo = Omit<ModelSpec, 'options'> & { optionsSchema?: Record<string, unknown> }

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
    read(ref: AssetRef): Promise<{
      data: Uint8Array
      mime: string
      duration?: number
      width?: number
      height?: number
    }>
  }
  /** 流式输出：text.chat 边生成边回调文本增量（宿主没要求时为空，平台照常一次返回） */
  stream?(delta: { text: string }): void
  /**
   * 这次调用的幂等键：同一个任务里的同一次调用（含重启、重新提交）不变。
   * 平台支持客户端幂等键或按客户端标识查任务时传给平台；不支持的忽略
   */
  idempotencyKey?: string
  /** 宿主在发送前持久化的关联信息；requestId 不代表平台支持幂等。 */
  submission?: {
    requestId: string
    /** 响应头到达时同步持久化；失败时不得继续读取或重新提交。 */
    response(info: { logId?: string; httpStatus: number }): void
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
  /**
   * 按幂等键（ctx.idempotencyKey）查提交过的任务：提交后没收到回应时宿主用它核查。
   * 找到返回远端任务 ID，查不到返回 null；查不了就抛错。
   * 查不到时只有同时声明了 idempotent 宿主才自动重新提交，否则仍交给用户核查。
   * 只有平台官方提供按客户端标识查询的接口时才实现
   */
  lookup?(
    idempotencyKey: string,
    ctx: ProviderContext<z.output<S>>,
  ): Promise<{ remoteId: string } | null>
  /**
   * 提交按 ctx.idempotencyKey 去重：同一个键重复提交不会产生第二个任务、不重复计费。
   * 只有平台官方承诺幂等时才声明；声明了，提交状态未知时宿主会用同一个键重新提交
   */
  idempotent?: boolean
  voiceClone?: VoiceCloneSpec<ProviderContext<z.output<S>>>
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
  models: ModelInfo[]
  /** 支持声音复刻时的表单说明 */
  voiceClone?: Pick<VoiceCloneSpec<never>, 'voiceId' | 'hint'>
  plugin: string
}

/** 没有远端 test 实现时只能检查配置，不能因缺省描述而声称验证了连接。 */
export function providerTestScope(def: {
  test?: unknown
  testScope?: 'connection' | 'configuration'
}): 'connection' | 'configuration' {
  return typeof def.test === 'function' && def.testScope !== 'configuration'
    ? 'connection'
    : 'configuration'
}

export function describeProvider(def: ProviderDefinition, plugin: string): ProviderDescriptor {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    docsUrl: def.docsUrl,
    testScope: providerTestScope(def),
    settingsSchema: z.toJSONSchema(def.settings, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >,
    secrets: def.secrets,
    models: def.models.map(({ options, ...m }) =>
      options
        ? {
            ...m,
            optionsSchema: z.toJSONSchema(options, {
              io: 'input',
              unrepresentable: 'any',
            }) as Record<string, unknown>,
          }
        : m,
    ),
    ...(def.voiceClone
      ? { voiceClone: { voiceId: def.voiceClone.voiceId, hint: def.voiceClone.hint } }
      : {}),
    plugin,
  }
}

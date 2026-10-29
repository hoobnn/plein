import { createHash, randomUUID } from 'node:crypto'
import { type CredentialLost, SequenceExportRequest, type SubmissionAudit } from '@plein/protocol'
import { createReadStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import {
  type AssetRef,
  Capability,
  CompositionSourceRef,
  type CapabilityInput,
  type ComposeSpec,
  type ExecutorContext,
  type MediaInfo,
  type ModelSpec,
  modelRef,
  type NodeOutputs,
  nodeKey,
  type PluginManifest,
  type PortValue,
  parseModelRef,
  type PollResult,
  portAccepts,
  type ProviderCallResult,
  type ProviderContext,
  type ProviderDefinition,
  ProviderError,
  providerConfigured,
  type ProviderOutput,
  resolveParams,
  type ServerPluginDefinition,
  type VoiceCreationResult,
  type VoiceCloneInput,
  type VoiceDesignInput,
} from '@plein/plugin-sdk'
import { stableStringify } from '@plein/flow'
import {
  compatibleBaseURL,
  COMPATIBLE_ID,
  createCompatiblePlugin,
  referenceStorageHost,
} from '@plein/providers'
import { Agent, Dispatcher1Wrapper } from 'undici'
import { composeVideo, compositionDuration, validateComposeOverlays } from '../assets/compose'
import { analyzeVideo } from '../assets/shot-analysis'
import { checkVideo } from '../assets/delivery-check'
import { DELIVERY_CHECK_LIMITS } from '@plein/nodes'
import { hasFfmpeg, probeMedia, mediaToolPaths, withMediaAbort } from '../assets/media'
import { SHOT_ANALYSIS_LIMITS } from '@plein/nodes'
import { MotionParams, CaptionLayerParams } from '@plein/nodes'
import { renderMotion } from '../motion/render'
import { renderCaptionLayer } from '../motion/captions'
import { motionChromePath, motionRendererIdentity } from '../motion/identity'
import type { AssetStore } from '../assets/store'
import type { OutputSpoolRef, SpoolBinding } from '../assets/output-spool'
import { credentialFingerprint as fingerprintOf, type ProviderConfigStore } from './config-store'
import { Limiter, sleep } from './limiter'
import type { PluginRegistry } from './registry'
import { PermissionError, scopedFetch, scopedSecrets } from './sandbox'

/** 异步任务最长等待时间 */
const DEFAULT_TIMEOUT_MS = 30 * 60_000

/**
 * 平台请求用的连接池：不设等响应头、读响应体的超时。
 * Node fetch 默认等响应头最多 5 分钟，同步出图在平台排队时会超过，被掐断后成了「提交状态未知」；
 * 一次调用多久算超时由上面的调用超时（signal）统一管
 */
// Electron 内置 fetch 仍使用 undici 7 的处理器协议；包装后兼容 undici 8 的连接池。
const providerDispatcher = new Dispatcher1Wrapper(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))
const providerFetch = ((input: Request, init?: RequestInit) =>
  fetch(input, { ...init, dispatcher: providerDispatcher } as RequestInit)) as typeof fetch
const DEFAULT_POLL_MS = 2_000

export class NodeRunError extends Error {
  /** 失败发生在哪一步（见 FailureStage）；任务恢复据此给出可执行的处理 */
  stage?: FailureStage
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'NodeRunError'
  }
}

/**
 * 模型调用失败在哪一步：
 * - submit_unknown：提交后没收到回应，不知道平台有没有受理
 * - fetch_failed：平台已生成，下载或保存到本地失败（调用记录里留着结果，可重新获取）
 * - remote_failed：平台明确返回失败
 * - remote_canceled：平台那边取消了任务
 */
export type FailureStage = 'submit_unknown' | 'fetch_failed' | 'remote_failed' | 'remote_canceled'

/** 给错误标上失败的步骤 */
function staged<E extends Error>(err: E, stage: FailureStage): E {
  ;(err as E & { stage?: FailureStage }).stage = stage
  return err
}

/** 错误上标的失败步骤；没标时为空 */
export function stageOf(err: unknown): FailureStage | undefined {
  return (err as { stage?: FailureStage } | undefined)?.stage
}

/** 原密钥组已删除或内容已换；音色来源决定任务能不能改用当前组重提 */
function lostCredential<E extends Error>(err: E, credentialLost: CredentialLost): E {
  return Object.assign(err, { credentialLost })
}

export function credentialLostOf(err: unknown): CredentialLost | undefined {
  return (err as { credentialLost?: CredentialLost } | undefined)?.credentialLost
}

/** 文件结果在调用记录里的样子：直接给的字节转成 base64，过大时丢掉（只能重新查询平台） */
type RecordedOutput =
  | Exclude<ProviderOutput, { type: 'file' }>
  | (Omit<Extract<ProviderOutput, { type: 'file' }>, 'data'> & {
      base64?: string
      dropped?: true
      spool?: OutputSpoolRef
    })

/** 调用记录里内嵌字节的上限；超过的文件结果不存字节，重新获取时只能再查平台 */
const RECORD_DATA_LIMIT = 16 * 1024 * 1024

/**
 * 一次节点运行内的模型调用记录。服务重启或重新获取时，按记录接着做，不重复提交（也就不重复计费）：
 * - submitting：已发出提交、还没收到回应（进程在这时退出，重启后按状态未知处理）
 * - unknown：提交后没收到回应，不知道平台有没有受理；有查询或幂等合同才自动核查，否则等人工处理
 * - pending：平台已受理，接着轮询；canceled 表示用户取消过（平台不一定真的停了）
 * - fetched：平台已生成，结果还没存到本地（下载或保存失败时留着，重新获取时直接再存）
 * - done：结果已入库
 */
export interface SubmissionTrace {
  attemptId: string
  requestId: string
  logId?: string
  httpStatus?: number
}
export type CallRecord = {
  trace?: SubmissionTrace
  provider?: string
  credentialId?: string
  credentialFingerprint?: string
  credentialLabel?: string
  /** 组是否由配音音色解析；恢复时禁止绕过音色改用当前组重提 */
  credentialSource?: 'voice'
  credentialVoice?: string
} & (
  | { state: 'submitting'; at: number }
  | { state: 'unknown'; at: number; message: string }
  | { state: 'pending'; remoteId: string; canceled?: true }
  | {
      state: 'fetched'
      remoteId?: string
      outputs: RecordedOutput[]
      usage?: ProviderCallResult['usage']
    }
  /** remoteId：异步任务的远端 ID，完成后也留着，便于核对有没有重复提交 */
  | {
      state: 'done'
      result: ProviderCallResult
      remoteId?: string
      dataAssets?: Record<number, AssetRef>
    }
)

/** 平台 → 密钥组 → 还在提交、等待平台结果或等待结果入库的调用数 */
export type CredentialUsage = Record<string, Record<string, number>>

export function addCredentialUsage(usage: CredentialUsage, provider: string, record: CallRecord) {
  if (!record.credentialId || record.state === 'done') return
  const credentials = (usage[provider] ??= {})
  credentials[record.credentialId] = (credentials[record.credentialId] ?? 0) + 1
}

/**
 * 服务退出时中止运行用的 reason：不取消远端任务、不清调用记录，重启后接着轮询
 */
export const SHUTDOWN = Symbol('plein.shutdown')

export interface CallJournal {
  /** 所属任务；用来生成稳定的幂等键 */
  id?: string
  get(key: string): CallRecord | undefined
  set(key: string, record: CallRecord, audit?: SubmissionAudit): void
  delete(key: string): void
}

/** 提交时抛的错误是不是「不知道到没到平台」：网络断在半路、超时、响应读不出来 */
function ambiguous(err: unknown) {
  if (!(err instanceof ProviderError)) return !(err instanceof PermissionError)
  if (err.outcome === 'unknown') return true
  return err.code === 'unknown' || err.code === 'timeout'
}

/** 结果地址过期或失效（重新查询平台可能拿到新地址） */
const EXPIRED = new Set([401, 403, 404, 410])

function recordOutputs(outputs: ProviderOutput[]): RecordedOutput[] {
  let budget = RECORD_DATA_LIMIT
  return outputs.map((o) => {
    if (o.type !== 'file' || !o.data) return o
    const { data, ...rest } = o
    if (data.byteLength > budget) return { ...rest, dropped: true as const }
    budget -= data.byteLength
    return { ...rest, base64: Buffer.from(data).toString('base64') }
  })
}

function restoreOutputs(outputs: RecordedOutput[]): ProviderOutput[] | undefined {
  if (outputs.some((o) => o.type === 'file' && 'dropped' in o && o.dropped)) return undefined
  return outputs.map((o) => {
    if (o.type !== 'file') return o
    const {
      base64,
      dropped: _,
      spool: _spool,
      ...rest
    } = o as Extract<RecordedOutput, { type: 'file' }>
    return base64 ? { ...rest, data: new Uint8Array(Buffer.from(base64, 'base64')) } : rest
  })
}

/** 只在服务退出时中止的信号：用户取消后已生成的结果照样存下来 */
function shutdownOnly(signal: AbortSignal | undefined) {
  const ctrl = new AbortController()
  if (!signal) return ctrl.signal
  const check = () => {
    if (signal.reason === SHUTDOWN) ctrl.abort(SHUTDOWN)
  }
  if (signal.aborted) check()
  else signal.addEventListener('abort', check, { once: true })
  return ctrl.signal
}

/** 一次模型调用所处的阶段，见 @plein/doc 的 RunPhase */
export interface CallStage {
  phase: 'waiting' | 'submitting' | 'accepted' | 'queued' | 'generating' | 'saving'
  /** 平台和模型，如“火山方舟 · Seedance 1.0 Pro” */
  via: string
}

export interface RunNodeOptions {
  type: string
  /** 文档里节点的版本；低于已安装版本时先迁移参数 */
  version: number
  params?: Record<string, unknown>
  inputs?: Record<string, PortValue[]>
  ownerId: string
  signal?: AbortSignal
  onProgress?(fraction: number, message?: string): void
  /** 执行器调模型时阶段变化（排队、提交、生成、下载结果） */
  onStage?(stage: CallStage): void
  journal?: CallJournal
}

const toError = (err: unknown): ProviderError => {
  if (err instanceof ProviderError) return err
  if (err instanceof PermissionError)
    return new ProviderError('invalid_input', err.message, { cause: err })
  if ((err as Error)?.name === 'AbortError')
    return new ProviderError('cancelled', '已取消', { cause: err })
  return new ProviderError('unknown', (err as Error)?.message ?? String(err), { cause: err })
}

/** 提交状态未知：不自动重试，等核查或人工处理 */
function unknownSubmit(platform: string, message: string, cause?: unknown) {
  return staged(
    new ProviderError(
      'unknown',
      `提交后没有收到${platform}的确认，无法判断是否已受理（${message}）`,
      {
        retryable: false,
        cause,
        outcome: 'unknown',
      },
    ),
    'submit_unknown',
  )
}

/** 平台已生成，下载或保存失败；网络类错误可自动重试（只是重新下载，不重新提交） */
function fetchFailed(err: unknown, remoteId: string | undefined, requery: boolean) {
  const e = toError(err)
  const status = (err as { status?: number }).status
  const expired = status !== undefined && EXPIRED.has(status)
  const note = expired
    ? requery
      ? '结果地址已失效，重新查询平台后仍未取到'
      : '结果地址已失效，平台不支持重新查询'
    : e.message
  const code = e.code === 'cancelled' ? 'unavailable' : e.code
  return Object.assign(
    staged(
      new ProviderError(code, `平台已生成，保存到本地失败：${note}`, {
        retryable: !expired && e.retryable,
        cause: err,
      }),
      'fetch_failed',
    ),
    { remoteId, expired },
  )
}

/**
 * 插件宿主：把注册表里的声明变成可运行的能力。
 * - Provider 调用归一化：选平台、注入配置与密钥、限流、轮询异步任务、超时与取消、结果文件入库；
 * - 节点执行：参数迁移与校验、输入输出端口校验，执行器只能经过宿主访问模型和资产。
 */
export class PluginHost {
  private limiters = new Map<string, Limiter>()

  /** 本地导出记录使用实际入库元数据，不访问平台。 */
  assetInfo(ownerId: string, assetId: string) {
    return this.assets.get(ownerId, assetId) ?? undefined
  }

  /** Local integrity check without materializing an entire media file in memory. */
  verifyAsset(ownerId: string, assetId: string) {
    return this.assets.verifyOriginal(ownerId, assetId)
  }

  constructor(
    readonly registry: PluginRegistry,
    readonly configs: ProviderConfigStore,
    private assets: AssetStore,
    private opts: {
      timeoutMs?: number
      log?: (plugin: string, message: string, data?: unknown) => void
      /** 平台请求用的 fetch；测试里可换掉 */
      fetch?: typeof fetch
      /** 配音音色创建时所用的密钥组；旧音色和平台预置音色不返回 */
      voiceCredential?: (
        ownerId: string,
        provider: string,
        voiceId: string,
      ) =>
        | {
            credentialId: string
            credentialFingerprint?: string
            credentialLabel?: string
            voiceName: string
          }
        | undefined
    } = {},
  ) {}

  load(plugins: ServerPluginDefinition[], builtin: boolean) {
    for (const p of plugins) {
      const entry = this.registry.register(p, { builtin })
      if (entry.status === 'error') this.log(entry.manifest.id, `加载失败：${entry.error}`)
    }
    this.refreshConfiguredProviders()
  }

  private compatibleDescriptor = ''

  /** Only the trusted built-in channel may derive its exact network permission from owner settings. */
  refreshConfiguredProviders() {
    if (!this.registry.plugin(COMPATIBLE_ID)?.builtin) return
    const settings = this.configs.get(COMPATIBLE_ID).settings
    const signature = stableStringify(settings)
    if (signature === this.compatibleDescriptor) return
    const plugin = createCompatiblePlugin(settings)
    this.registry.unregister(COMPATIBLE_ID)
    this.registry.register(plugin, { builtin: true })
    this.compatibleDescriptor = signature
  }

  // ── Provider ──────────────────────────────────────

  /** 已启用平台中支持某能力的模型 */
  models(capability: Capability): Array<ModelSpec & { ref: string; provider: string }> {
    this.refreshConfiguredProviders()
    const out: Array<ModelSpec & { ref: string; provider: string }> = []
    for (const [id, { def }] of this.registry.providers) {
      if (!this.configs.get(id).enabled) continue
      for (const m of def.models) {
        if (m.capabilities.includes(capability))
          out.push({ ...m, ref: modelRef(id, m.id), provider: id })
      }
    }
    return out
  }

  /**
   * 某能力的默认模型：设置里指定的那个；还没指定，或指定的平台已停用、模型已下架时，
   * 改为已启用平台里第一个支持该能力的模型并记下来，之后启用别的平台不会再变。没有可用模型时返回空串
   */
  defaultModel(capability: Capability): string {
    const models = this.models(capability)
    const saved = this.configs.defaultModel(capability)
    if (saved && models.some((m) => m.ref === saved)) return saved
    const first = models[0]?.ref
    if (!first) return ''
    this.configs.setDefaultModel(capability, first)
    return first
  }

  /** 各能力的默认模型；没有可用模型的能力不列出 */
  defaultModels(): Partial<Record<Capability, string>> {
    return Object.fromEntries(
      Capability.options.flatMap((c) => {
        const ref = this.defaultModel(c)
        return ref ? [[c, ref]] : []
      }),
    )
  }

  /** 测试连接：校验配置与密钥；没有 test 方法的平台只校验配置 */
  async testProvider(id: string, ownerId: string, signal?: AbortSignal, credentialId?: string) {
    this.refreshConfiguredProviders()
    const entry = this.registry.providers.get(id)
    if (!entry) throw new ProviderError('invalid_input', `平台 ${id} 未安装`)
    const ctx = this.providerContext(id, ownerId, signal ?? new AbortController().signal, {
      requireEnabled: false,
      credentialId,
    })
    try {
      await entry.def.test?.(ctx)
    } catch (err) {
      throw toError(err)
    }
  }

  /** 平台的声音复刻说明；没装或不支持时为空 */
  voiceClone(id: string) {
    return this.registry.providers.get(id)?.def.voiceClone
  }

  /** 在平台上复刻音色（计费）：样本从调用者的资产库读，平台必须已启用 */
  async cloneVoice(
    id: string,
    ownerId: string,
    input: VoiceCloneInput,
    signal?: AbortSignal,
    credentialId?: string,
    credentialFingerprint?: string,
    credentialLabel?: string,
  ): Promise<VoiceCreationResult> {
    const spec = this.voiceClone(id)
    if (!spec) throw new ProviderError('invalid_input', `平台 ${id} 不支持声音复刻`)
    const ctx = this.providerContext(id, ownerId, signal ?? new AbortController().signal, {
      requireEnabled: true,
      credentialId,
      credentialFingerprint,
      credentialLabel,
    })
    try {
      return await spec.clone(input, ctx)
    } catch (err) {
      throw toError(err)
    }
  }

  voiceDesign(id: string) {
    return this.registry.providers.get(id)?.def.voiceDesign
  }

  async designVoice(
    id: string,
    ownerId: string,
    input: VoiceDesignInput,
    signal?: AbortSignal,
    credentialId?: string,
    credentialFingerprint?: string,
    credentialLabel?: string,
  ): Promise<VoiceCreationResult> {
    const spec = this.voiceDesign(id)
    if (!spec) throw new ProviderError('invalid_input', `平台 ${id} 不支持音色设计`)
    const ctx = this.providerContext(id, ownerId, signal ?? new AbortController().signal, {
      requireEnabled: true,
      credentialId,
      credentialFingerprint,
      credentialLabel,
    })
    try {
      return await spec.design(input, ctx)
    } catch (err) {
      throw toError(err)
    }
  }

  /** 查复刻训练状态；平台不提供查询时返回空，沿用已记下的状态 */
  async voiceStatus(
    id: string,
    ownerId: string,
    voiceId: string,
    signal?: AbortSignal,
    credentialId?: string,
    credentialFingerprint?: string,
    credentialLabel?: string,
    voiceName?: string,
  ): Promise<VoiceCreationResult | null> {
    const spec = this.voiceClone(id)
    if (!spec?.status) return null
    const ctx = this.providerContext(id, ownerId, signal ?? new AbortController().signal, {
      requireEnabled: true,
      credentialId,
      credentialFingerprint,
      credentialLabel,
      credentialVoice: voiceName,
      voiceName,
    })
    try {
      return await spec.status(voiceId, ctx)
    } catch (err) {
      throw toError(err)
    }
  }

  /** 调用模型能力；文件类结果下载后存入调用者的资产库 */
  async call<C extends Capability>(
    capability: C,
    ref: string,
    input: CapabilityInput<C>,
    opts: {
      ownerId: string
      signal?: AbortSignal
      onProgress?: (p: number) => void
      onStage?: (stage: CallStage) => void
      /** 对话流式输出的文本增量 */
      onDelta?: (text: string) => void
      /** 调用记录与这次调用的键，见 CallJournal */
      journal?: { store: CallJournal; key: string }
    },
  ): Promise<ProviderCallResult> {
    const journal = opts.journal
    const recorded = journal?.store.get(journal.key)
    if (recorded?.state === 'done') {
      // 内部记录仅存资产引用；恢复时还原公开 outputs.data，不能改变插件读取字节的合同。
      try {
        return await this.assets.activity.run(async () => {
          for (const asset of recorded.result.assets)
            await this.assets.verifyOriginal(opts.ownerId, asset.assetId)
          return {
            ...recorded.result,
            outputs: await Promise.all(
              recorded.result.outputs.map(async (output, index) => {
                const asset = recorded.dataAssets?.[index]
                if (!asset) return output
                if (output.type !== 'file') throw new Error('已完成输出的字节引用与文件不匹配')
                return {
                  ...output,
                  data: await this.assets.readOriginal(opts.ownerId, asset.assetId),
                }
              }),
            ),
          }
        })
      } catch (error) {
        throw fetchFailed(
          new ProviderError('unavailable', `已入库输出无法读取：${(error as Error).message}`, {
            retryable: false,
          }),
          recorded.remoteId,
          false,
        )
      }
    }
    let trace = recorded?.trace
    let provider = recorded?.provider
    let credentialId = recorded?.credentialId
    let credentialFingerprint = recorded?.credentialFingerprint
    let credentialLabel = recorded?.credentialLabel
    let credentialSource = recorded?.credentialSource
    let credentialVoice = recorded?.credentialVoice
    const record = (r: CallRecord, kind?: SubmissionAudit['kind']) => {
      journal?.store.set(
        journal.key,
        {
          ...r,
          ...(trace ? { trace } : {}),
          ...(provider ? { provider } : {}),
          ...(credentialId ? { credentialId } : {}),
          ...(credentialFingerprint ? { credentialFingerprint } : {}),
          ...(credentialLabel ? { credentialLabel } : {}),
          ...(credentialSource ? { credentialSource } : {}),
          ...(credentialVoice ? { credentialVoice } : {}),
        },
        kind
          ? {
              id: randomUUID(),
              at: Date.now(),
              callKey: journal.key,
              kind,
              ...trace,
            }
          : undefined,
      )
    }

    this.refreshConfiguredProviders()
    const parsed = parseModelRef(ref)
    if (!parsed) throw new ProviderError('invalid_input', `模型引用格式不正确：${ref}`)
    provider ??= parsed.provider
    const entry = this.registry.providers.get(parsed.provider)
    if (!entry) throw new ProviderError('unavailable', `平台 ${parsed.provider} 未安装`)
    const model = entry.def.models.find((m) => m.id === parsed.model)
    if (!model)
      throw new ProviderError('invalid_input', `平台 ${entry.def.title} 没有模型 ${parsed.model}`)
    if (!model.capabilities.includes(capability)) {
      throw new ProviderError('invalid_input', `模型 ${model.title} 不支持 ${capability}`)
    }

    // 模型声明不支持的参数不传：节点上残留的取值（表单已隐藏）不该让整次生成失败
    const unsupported = (['seed', 'duration', 'speed', 'instruction', 'audio'] as const).filter(
      (k) => model.limits?.[k] === false,
    )
    if (unsupported.some((k) => k in input)) {
      const rest = { ...input } as Record<string, unknown>
      for (const k of unsupported) delete rest[k]
      input = rest as unknown as typeof input
    }

    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
    // 同一个任务里的同一次调用，幂等键不变（重启、重新提交都一样）
    const idempotencyKey = journal?.store.id
      ? `plein-${createHash('sha256').update(`${journal.store.id}\n${journal.key}`).digest('hex').slice(0, 32)}`
      : undefined
    const voiceId =
      capability === 'audio.speech' ? (input as CapabilityInput<'audio.speech'>).voice : undefined
    const voiceCredential =
      !credentialId && voiceId
        ? this.opts.voiceCredential?.(opts.ownerId, parsed.provider, voiceId)
        : undefined
    if (voiceCredential) {
      credentialId = voiceCredential.credentialId
      credentialFingerprint = voiceCredential.credentialFingerprint
      credentialSource = 'voice'
      credentialVoice = voiceCredential.voiceName
    }
    const providerConfig = this.configs.get(parsed.provider)
    credentialId ??= providerConfig.activeCredential
    const credential = providerConfig.credentials.find((item) => item.id === credentialId)
    credentialLabel ??= credential?.label ?? voiceCredential?.credentialLabel
    credentialFingerprint ??= credential ? fingerprintOf(credential.secrets) : undefined
    if (voiceCredential && !credential)
      throw lostCredential(
        new ProviderError(
          'auth',
          `音色「${voiceCredential.voiceName}」所属的 Key「${voiceCredential.credentialLabel ?? credentialId!.slice(0, 8)}」已删除，请在节点上改用其他音色，或重新复刻后再运行。`,
          { retryable: false },
        ),
        { reason: 'missing', voice: voiceCredential.voiceName },
      )
    if (
      voiceCredential &&
      credentialFingerprint &&
      fingerprintOf(credential!.secrets) !== credentialFingerprint
    )
      throw lostCredential(
        new ProviderError(
          'auth',
          `音色「${voiceCredential.voiceName}」所属的 Key「${credential?.label ?? voiceCredential.credentialLabel ?? credentialId!.slice(0, 8)}」已被替换，请在节点上改用其他音色，或重新复刻后再运行。`,
          { retryable: false },
        ),
        { reason: 'replaced', voice: voiceCredential.voiceName },
      )
    const { onDelta } = opts
    let ctx: ProviderContext | undefined
    const providerCtx = () => {
      if (!ctx) {
        ctx = this.providerContext(parsed.provider, opts.ownerId, signal, {
          requireEnabled: true,
          idempotencyKey,
          credentialId,
          credentialFingerprint,
          credentialLabel,
          credentialVoice,
        })
        if (onDelta) ctx.stream = (d) => onDelta(d.text)
      }
      return ctx
    }
    const { def } = entry
    const limiter = this.limiter(parsed.provider, def.limits)
    const via =
      providerConfig.credentials.length >= 2 && credential
        ? `${def.title}（${credential.label}）· ${model.title}`
        : `${def.title} · ${model.title}`
    const stage = (phase: CallStage['phase']) => opts.onStage?.({ phase, via })
    // 远端已受理、且没有明确失败：此后的错误（轮询或下载结果时网络抖动、超时、用户取消）
    // 保留调用记录，重试、重启或重新获取时接着轮询，不能重新提交付费任务
    let remoteFailed = false
    let remote: string | undefined
    const spools = new Map<number, OutputSpoolRef>()
    const binding = (outputIndex: number): SpoolBinding => ({
      ownerId: opts.ownerId,
      jobId: journal?.store.id ?? '',
      callKey: journal?.key ?? '',
      ...(trace?.attemptId ? { attemptId: trace.attemptId } : {}),
      outputIndex,
    })
    const saveFetched = async (outputs: ProviderOutput[], usage?: ProviderCallResult['usage']) => {
      let saved = recordOutputs(outputs)
      const publish = () =>
        record({
          state: 'fetched',
          outputs: saved,
          ...(usage ? { usage } : {}),
          ...(remote ? { remoteId: remote } : {}),
        })
      try {
        await this.assets.activity.run(async () => {
          spools.clear()
          if (journal?.store.id) {
            for (const [index, output] of outputs.entries()) {
              if (output.type !== 'file' || !output.data) continue
              const spool = this.assets.outputSpool.describe(output.data, binding(index))
              const { data: _data, ...metadata } = output
              saved[index] = { ...metadata, spool }
              spools.set(index, spool)
            }
          }
          // 在首次磁盘写入前保存调用绑定，闭合 rename 完成而 journal 尚未更新的退出窗口。
          publish()
          for (const [index, spool] of spools) {
            const output = outputs[index]!
            if (output.type !== 'file' || !output.data) throw new Error('暂存输出缺少字节')
            const ready = await this.assets.outputSpool.write(spool, output.data, binding(index))
            saved[index] = {
              ...(saved[index] as Extract<RecordedOutput, { type: 'file' }>),
              spool: ready,
            }
            spools.set(index, ready)
          }
          publish()
        })
      } catch (error) {
        // 预登记或磁盘失败不意味着未提交；尽力保留 fetched/dropped 事实，绝不退回 submit。
        if (!journal?.store.get(journal.key) || journal.store.get(journal.key)?.state !== 'fetched')
          publish()
        throw fetchFailed(
          new ProviderError('unavailable', `平台输出暂存失败：${(error as Error).message}`, {
            retryable: false,
          }),
          remote,
          !!(remote && def.poll),
        )
      }
    }
    let fetched: { outputs: ProviderOutput[]; usage?: ProviderCallResult['usage'] } | undefined
    if (recorded?.state === 'fetched') {
      remote = recorded.remoteId
      const outputs = restoreOutputs(recorded.outputs)
      if (outputs) {
        fetched = { outputs, usage: recorded.usage }
        for (const [index, output] of recorded.outputs.entries())
          if (output.type === 'file' && output.spool) spools.set(index, output.spool)
      }
    }

    /** 轮询远端任务直到结束 */
    const pollUntilDone = async (remoteId: string, first: number) => {
      let wait = first
      try {
        for (;;) {
          await sleep(wait, signal)
          const r: PollResult = await def.poll!(remoteId, providerCtx())
          if (r.state === 'succeeded') return r
          if (r.state === 'failed') {
            remoteFailed = true
            const err = new ProviderError(r.error.code, r.error.message, {
              retryable: r.error.retryable,
            })
            throw staged(err, r.error.code === 'cancelled' ? 'remote_canceled' : 'remote_failed')
          }
          // 平台未报告排队或生成时，只能确认已受理，不能推测实际进度。
          stage(
            r.remote === 'queued' ? 'queued' : r.remote === 'running' ? 'generating' : 'accepted',
          )
          if (r.progress !== undefined) opts.onProgress?.(r.progress)
          wait = r.pollAfterMs ?? DEFAULT_POLL_MS
        }
      } catch (err) {
        // 用户取消或超时：通知平台取消远端任务（尽力而为）；平台不一定停得下来，调用记录留着
        if (signal.aborted && !remoteFailed && opts.signal?.reason !== SHUTDOWN) {
          if (opts.signal?.aborted) record({ state: 'pending', remoteId, canceled: true })
          if (def.cancel) {
            // 生成的 signal 已中止；取消请求必须使用独立、有限时长的上下文。
            const cancelCtx = this.providerContext(
              parsed.provider,
              opts.ownerId,
              AbortSignal.timeout(10_000),
              {
                requireEnabled: false,
                credentialId,
                credentialFingerprint,
                credentialLabel,
                credentialVoice,
              },
            )
            await def.cancel(remoteId, cancelCtx).catch(() => {})
          }
        }
        throw err
      }
    }

    try {
      if (!fetched) {
        if (limiter.full) stage('waiting')
        fetched = await limiter.run(async () => {
          // 受理记录不能退回提交：平台升级移除了查询合同，或同步大文件没有可恢复字节时，
          // 保留原调用记录供人工处理，不能用新生成冒充“重新获取”。
          if (recorded?.state === 'pending' && !def.poll)
            throw new ProviderError(
              'unavailable',
              '平台已受理，但当前不支持重新查询；没有重新提交',
              {
                retryable: false,
              },
            )
          if (recorded?.state === 'fetched' && !(recorded.remoteId && def.poll))
            throw fetchFailed(
              new ProviderError(
                'unavailable',
                '结果没有可恢复的本地字节，平台不支持重新查询；没有重新提交',
                {
                  retryable: false,
                },
              ),
              recorded.remoteId,
              false,
            )
          if (recorded?.state === 'pending' && def.poll) {
            // 之前已经提交过（重启、重试或重新获取）：接着轮询，不再提交
            remote = recorded.remoteId
            stage('accepted')
            return pollUntilDone(recorded.remoteId, 0)
          }
          if (recorded?.state === 'fetched' && recorded.remoteId && def.poll) {
            // 记录里的结果没存字节：再查一次平台拿结果
            remote = recorded.remoteId
            stage('accepted')
            return pollUntilDone(recorded.remoteId, 0)
          }
          if (recorded?.state === 'submitting' || recorded?.state === 'unknown') {
            // 上次提交没收到回应：有查询合同就先查，查不到或没有查询合同时，只有幂等才用同一个键重新提交
            const found = await this.verifySubmit(def, providerCtx(), idempotencyKey, recorded)
            if (found) {
              remote = found.remoteId
              record({ state: 'pending', remoteId: found.remoteId })
              stage('accepted')
              return pollUntilDone(found.remoteId, 0)
            }
          }
          let submitted: Awaited<ReturnType<typeof def.submit>>
          let verified = false
          const context = providerCtx()
          for (;;) {
            stage('submitting')
            trace = { attemptId: randomUUID(), requestId: randomUUID() }
            // 同步落盘失败时不会进入 submit，更不会发请求。
            record({ state: 'submitting', at: Date.now() }, 'submit_started')
            context.submission = {
              requestId: trace.requestId,
              response: ({ logId, httpStatus }) => {
                const safeLog = logId?.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 160)
                trace = { ...trace!, httpStatus, ...(safeLog ? { logId: safeLog } : {}) }
                const current = journal?.store.get(journal.key)
                if (current) record(current, 'response')
              },
            }
            try {
              submitted = await def.submit({ capability, model: parsed.model, input }, context)
              break
            } catch (err) {
              // 服务退出：留着 submitting，重启后按状态未知核查
              if (opts.signal?.reason === SHUTDOWN) throw err
              // 没有调用记录（智能体、插件能力直接调用）时无从恢复，原样抛出
              if (!journal || !ambiguous(err)) {
                journal?.store.delete(journal.key)
                throw err
              }
              const message = (err as Error)?.message ?? String(err)
              const unknown = { state: 'unknown' as const, at: Date.now(), message }
              record(unknown, 'submit_unknown')
              if (opts.signal?.aborted) throw err
              // 平台有查询或幂等合同：马上核查一次；查到就接着轮询，幂等时用同一个键再提交一次
              if (verified || !(def.lookup || def.idempotent))
                throw unknownSubmit(def.title, message, err)
              verified = true
              const found = await this.verifySubmit(def, providerCtx(), idempotencyKey, unknown)
              if (found) {
                remote = found.remoteId
                record({ state: 'pending', remoteId: found.remoteId })
                stage('accepted')
                return pollUntilDone(found.remoteId, 0)
              }
            }
          }
          if (submitted.state === 'succeeded') return submitted
          remote = submitted.remoteId
          // 平台受理是持久事实；即使插件缺少查询实现，也先保存已知远端 ID。
          record({ state: 'pending', remoteId: submitted.remoteId })
          stage('accepted')
          if (!def.poll)
            throw new ProviderError(
              'unavailable',
              `平台 ${def.title} 已受理，但当前不支持重新查询；没有重新提交`,
              { retryable: false },
            )
          return pollUntilDone(submitted.remoteId, submitted.pollAfterMs ?? DEFAULT_POLL_MS)
        }, signal)
        await saveFetched(fetched.outputs, fetched.usage)
      }
    } catch (err) {
      const error =
        timeout.aborted && !opts.signal?.aborted
          ? new ProviderError('timeout', '任务超时')
          : toError(err)
      const failedAt = stageOf(err)
      if (failedAt) staged(error, failedAt)
      // 平台明确失败：删掉记录，重跑时重新提交；其余情况（受理后出错、提交状态未知）记录留着
      if (remoteFailed) journal?.store.delete(journal.key)
      throw error
    }

    // 下载、保存结果：用户取消了也照样存（已经生成、可能已计费），只有服务退出时中止
    const storeSignal = AbortSignal.any([
      AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      shutdownOnly(opts.signal),
    ])
    return this.assets.activity
      .run(async () => {
        let outputs = fetched.outputs
        if (outputs.some((o) => o.type === 'file')) stage('saving')
        let assets: AssetRef[]
        try {
          // 只有远端 URL 的结果仍需下载；本地字节或 spool 完整的恢复不校验 Key。
          if (
            outputs.some(
              (output, index) =>
                output.type === 'file' && !!output.url && !output.data && !spools.has(index),
            )
          )
            providerCtx()
          assets = await this.storeOutputs(
            parsed.provider,
            outputs,
            opts.ownerId,
            storeSignal,
            spools,
            binding,
          )
        } catch (err) {
          // 结果地址过期：平台能再查就拿一份新地址再存一次
          const status = (err as { status?: number }).status
          if (status && EXPIRED.has(status) && remote && def.poll && !storeSignal.aborted) {
            try {
              const again = await def.poll(remote, providerCtx())
              if (again.state !== 'succeeded') throw err
              outputs = again.outputs
              await saveFetched(outputs, fetched.usage)
              assets = await this.storeOutputs(
                parsed.provider,
                outputs,
                opts.ownerId,
                storeSignal,
                spools,
                binding,
              )
            } catch (again) {
              throw fetchFailed(again, remote, true)
            }
          } else throw fetchFailed(err, remote, !!(remote && def.poll))
        }
        const dataAssets: Record<number, AssetRef> = {}
        let fileIndex = 0
        const publicOutputs: ProviderOutput[] = []
        const storedOutputs: ProviderOutput[] = []
        for (const [index, output] of outputs.entries()) {
          if (output.type !== 'file') {
            publicOutputs.push(output)
            storedOutputs.push(output)
            continue
          }
          const asset = assets[fileIndex++]!
          if (output.data || spools.has(index)) {
            dataAssets[index] = asset
            const { data: _data, ...metadata } = output
            storedOutputs.push(metadata)
            publicOutputs.push({
              ...metadata,
              data: output.data ?? (await this.assets.readOriginal(opts.ownerId, asset.assetId)),
            })
          } else {
            publicOutputs.push(output)
            storedOutputs.push(output)
          }
        }
        const result: ProviderCallResult = { outputs: publicOutputs, assets, usage: fetched.usage }
        record({
          state: 'done',
          result: { ...result, outputs: storedOutputs },
          ...(Object.keys(dataAssets).length ? { dataAssets } : {}),
          ...(remote ? { remoteId: remote } : {}),
        })
        // done 已经持久化才删除恢复副本；删除失败保留孤儿，后续按引用和宽限期清理。
        for (const [index, spool] of spools)
          await this.assets.outputSpool
            .remove(spool, binding(index))
            .catch((error) =>
              this.log(entry.plugin, '平台输出暂存清理失败', { message: (error as Error).message }),
            )
        return result
      })
      .catch((error) => {
        if (stageOf(error)) throw error
        // 包含 ingest 后的结果登记/公开字节恢复失败；已受理事实不能退回无恢复状态。
        throw fetchFailed(error, remote, !!(remote && def.poll))
      })
  }

  /**
   * 提交状态未知时核查：平台实现了 lookup 就按幂等键查，找到返回远端任务。
   * 返回 null 表示可以用同一个键接着提交，只在平台声明了幂等提交时才会这样：
   * 查不到不等于没受理（平台的查询可能有延迟），不幂等时重新提交可能重复计费，
   * 所以仍按「状态未知」交给用户稍后重新核查或确认后重新提交
   */
  private async verifySubmit(
    def: ProviderDefinition,
    ctx: ProviderContext,
    key: string | undefined,
    recorded: Extract<CallRecord, { state: 'submitting' | 'unknown' }>,
  ): Promise<{ remoteId: string } | null> {
    const message = recorded.state === 'unknown' ? recorded.message : '上次提交时服务退出'
    if (key && def.lookup) {
      let found: { remoteId: string } | null
      try {
        found = await def.lookup(key, ctx)
      } catch (err) {
        throw unknownSubmit(def.title, `${message}；核查失败：${(err as Error).message}`, err)
      }
      if (found || def.idempotent) return found
      throw unknownSubmit(
        def.title,
        `${message}；平台暂时查不到这个任务，可能还没同步，请稍后重新核查`,
      )
    }
    if (key && def.idempotent) return null
    throw unknownSubmit(def.title, message)
  }

  /** 内置方舟平台按设置额外放行用户自备的 S3 兼容存储主机，只放行上传会用到的那一个 */
  private storageHosts(id: string, plugin: string, settings: Record<string, unknown>) {
    if (!['volc/ark', 'volc/ark-plan'].includes(id) || !this.registry.plugin(plugin)?.builtin)
      return []
    const host = referenceStorageHost(settings)
    return host ? [host] : []
  }

  private providerContext(
    id: string,
    ownerId: string,
    signal: AbortSignal,
    opts: {
      requireEnabled: boolean
      idempotencyKey?: string
      credentialId?: string
      credentialFingerprint?: string
      credentialLabel?: string
      credentialVoice?: string
      voiceName?: string
    },
  ): ProviderContext {
    const { def, plugin } = this.registry.providers.get(id)!
    const manifest = this.manifest(plugin)
    const config = this.configs.get(id)
    const credential = this.configs.credential(id, opts.credentialId)
    const label =
      opts.credentialLabel ?? credential?.label ?? opts.credentialId?.slice(0, 8) ?? '默认'
    const credentialError = (reason: CredentialLost['reason']) => {
      const missing = reason === 'missing'
      const message = opts.voiceName
        ? `音色「${opts.voiceName}」所属的 Key「${label}」${missing ? '已删除' : '已被替换'}，无法查询训练状态。请恢复原 Key，或重新复刻`
        : opts.credentialVoice
          ? `音色「${opts.credentialVoice}」所属的 Key「${label}」${missing ? '已删除' : '已被替换'}，请在节点上改用其他音色，或重新复刻后再运行。`
          : missing
            ? `原来的 Key「${label}」已删除，无法取回之前的结果。为避免重复计费没有自动重新提交。`
            : `原来的 Key「${label}」已被替换，暂时无法取回结果。把这组 Key 改回原来的内容后可重新获取；不需要原结果的话，可以用当前 Key 重新提交（会再次计费）。`
      return lostCredential(new ProviderError('auth', message, { retryable: false }), {
        reason,
        ...(opts.credentialVoice ? { voice: opts.credentialVoice } : {}),
      })
    }
    if (opts.credentialId && !credential) throw credentialError('missing')
    const secrets = credential?.secrets ?? config.secrets
    if (opts.credentialFingerprint && fingerprintOf(secrets) !== opts.credentialFingerprint)
      throw credentialError('replaced')
    if (opts.requireEnabled && !config.enabled)
      throw new ProviderError('unavailable', `平台 ${def.title} 未启用`)
    const settings = def.settings.safeParse(config.settings)
    if (!settings.success)
      throw new ProviderError(
        'invalid_input',
        `平台 ${def.title} 的设置不正确：${settings.error.message}`,
      )
    for (const s of def.secrets) {
      if (s.required && !secrets[s.name])
        throw new ProviderError('auth', `平台 ${def.title} 缺少 ${s.title}`)
    }
    if (!providerConfigured(def, secrets))
      throw new ProviderError('auth', `平台 ${def.title} 缺少一组完整的鉴权密钥`)
    const fetchScoped = scopedFetch(
      manifest,
      this.opts.fetch ?? providerFetch,
      id === COMPATIBLE_ID && this.registry.plugin(plugin)?.builtin && settings.data.baseURL
        ? compatibleBaseURL(String(settings.data.baseURL)).origin
        : undefined,
      this.storageHosts(id, plugin, settings.data),
    )
    return {
      settings: settings.data,
      secret: scopedSecrets(manifest, secrets),
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        fetchScoped(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
        })) as typeof fetch,
      signal,
      log: (message, data) => this.log(plugin, message, data),
      files: { read: (ref) => this.readAsset(manifest, ownerId, ref) },
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    }
  }

  private async storeOutputs(
    provider: string,
    outputs: ProviderOutput[],
    ownerId: string,
    signal: AbortSignal,
    spools = new Map<number, OutputSpoolRef>(),
    binding?: (index: number) => SpoolBinding,
  ) {
    const manifest = this.manifest(this.registry.providers.get(provider)!.plugin)
    const refs: AssetRef[] = []
    for (const [index, out] of outputs.entries()) {
      if (out.type !== 'file') continue
      let body: Readable
      const spool = spools.get(index)
      if (spool && binding) body = await this.assets.outputSpool.read(spool, binding(index))
      else if (out.data) body = Readable.from([Buffer.from(out.data)])
      else if (out.url) {
        // 结果文件同样只能从声明过的域名下载
        const res = await scopedFetch(manifest)(out.url, { signal })
        if (!res.ok || !res.body)
          throw Object.assign(
            new ProviderError('unavailable', `下载结果失败：HTTP ${res.status}`, {
              retryable: !EXPIRED.has(res.status),
            }),
            { status: res.status },
          )
        body = Readable.fromWeb(res.body as never)
      } else throw new ProviderError('unknown', '平台返回的文件既没有 url 也没有 data')
      try {
        const asset = await this.assets.ingest(ownerId, body, {
          mime: out.mime,
          name: out.name ?? `${out.kind}`,
        })
        refs.push({ assetId: asset.id, kind: out.kind, mime: asset.mime })
      } finally {
        body.destroy()
      }
    }
    return refs
  }

  private limiter(id: string, limits?: { concurrency?: number; requestsPerMinute?: number }) {
    let l = this.limiters.get(id)
    if (!l) {
      l = new Limiter(
        limits?.concurrency ?? 4,
        limits?.requestsPerMinute ?? Number.POSITIVE_INFINITY,
      )
      this.limiters.set(id, l)
    }
    return l
  }

  // ── 节点执行 ──────────────────────────────────────

  async runNode(opts: RunNodeOptions): Promise<NodeOutputs> {
    const node = this.registry.latestNode(opts.type)
    if (!node) throw new NodeRunError('not_installed', `节点 ${opts.type} 未安装`)
    const key = nodeKey(node.def.type, node.def.version)
    const executor = this.registry.executors.get(key)
    if (!executor) throw new NodeRunError('not_executable', `节点 ${node.def.title} 没有执行器`)
    let params: Record<string, unknown>
    try {
      params = resolveParams(node.def, opts.params, opts.version)
    } catch (err) {
      throw new NodeRunError('invalid_params', `参数不正确：${(err as Error).message}`)
    }
    const inputs = opts.inputs ?? {}
    for (const port of node.def.inputs) {
      const values = inputs[port.id] ?? []
      if (port.required && values.length === 0)
        throw new NodeRunError('missing_input', `缺少输入：${port.label}`)
      if (!port.multiple && values.length > 1)
        throw new NodeRunError('invalid_input', `输入 ${port.label} 只能连一个`)
      for (const v of values) {
        if (!portAccepts(port.type, v.type))
          throw new NodeRunError('invalid_input', `输入 ${port.label} 不接受 ${v.type}`)
      }
    }

    const manifest = this.manifest(executor.plugin)
    const signal = opts.signal ?? new AbortController().signal
    // 同样的调用可能有意发多次（例如一次要多张候选图），按出现次序区分
    const seen = new Map<string, number>()
    const callKey = (capability: string, model: string, input: unknown) => {
      const hash = createHash('sha256')
        .update(stableStringify({ capability, model, input }))
        .digest('hex')
      const n = seen.get(hash) ?? 0
      seen.set(hash, n + 1)
      return `${hash}#${n}`
    }
    const ctx: ExecutorContext = {
      params,
      inputs,
      signal,
      progress: (f, m) => opts.onProgress?.(Math.min(1, Math.max(0, f)), m),
      log: (message, data) => this.log(executor.plugin, message, data),
      ...this.services(manifest, {
        ownerId: opts.ownerId,
        signal,
        onProgress: (p) => opts.onProgress?.(p),
        onStage: opts.onStage,
        journal: opts.journal && {
          store: opts.journal,
          key: (capability, model, input) => callKey(capability, model, input),
        },
      }),
    }

    let outputs: NodeOutputs
    try {
      outputs = await executor.def.run(ctx)
    } catch (err) {
      if (err instanceof NodeRunError) throw err
      const e = toError(err)
      const wrapped = new NodeRunError(e.code, e.message, e.retryable)
      wrapped.stage = stageOf(err)
      const credentialLost = credentialLostOf(e)
      if (credentialLost) Object.assign(wrapped, { credentialLost })
      throw wrapped
    }
    for (const [port, values] of Object.entries(outputs)) {
      const spec = node.def.outputs.find((p) => p.id === port)
      if (!spec) throw new NodeRunError('invalid_output', `执行器输出了未声明的端口 ${port}`)
      for (const v of values) {
        if (!portAccepts(spec.type, v.type))
          throw new NodeRunError('invalid_output', `输出 ${spec.label} 不应为 ${v.type}`)
        if ('assetId' in v && v.compositionSource) {
          const parsed = CompositionSourceRef.safeParse(v.compositionSource)
          if (!parsed.success) throw new NodeRunError('invalid_output', '动态合成来源不合法')
          for (const id of [
            parsed.data.bundleAssetId,
            parsed.data.manifestAssetId,
            ...parsed.data.dependencyAssetIds,
          ])
            if (!this.assets.get(opts.ownerId, id))
              throw new NodeRunError('invalid_output', '动态合成来源缺失或不可访问')
          v.compositionSource = parsed.data
        }
      }
    }
    return outputs
  }

  /**
   * 插件代码可用的宿主服务：调模型、读写资产、处理媒体，都按插件清单的权限裁剪。
   * 节点执行器和插件能力共用。
   */
  services(
    manifest: PluginManifest,
    opts: {
      ownerId: string
      signal: AbortSignal
      onProgress?: (fraction: number) => void
      onStage?: (stage: CallStage) => void
      journal?: {
        store: CallJournal
        key: (capability: string, model: string, input: unknown) => string
      }
    },
  ): Pick<ExecutorContext, 'providers' | 'assets' | 'media'> {
    const { ownerId, signal } = opts
    return {
      providers: {
        call: (capability, model, input) =>
          this.call(capability, model, input, {
            ownerId,
            signal,
            onProgress: opts.onProgress,
            onStage: opts.onStage,
            journal: opts.journal && {
              store: opts.journal.store,
              key: opts.journal.key(capability, model, input),
            },
          }),
        models: (capability) => this.models(capability),
      },
      assets: {
        put: async (file) => {
          if (manifest.permissions.assets !== 'write')
            throw new PermissionError(`插件 ${manifest.id} 没有写资产的权限`)
          const a = await this.assets.ingest(ownerId, Readable.from([Buffer.from(file.data)]), {
            mime: file.mime,
            name: file.name ?? 'file',
          })
          return { assetId: a.id, kind: a.kind, mime: a.mime }
        },
        read: (ref) => this.readAsset(manifest, ownerId, ref),
      },
      media: {
        renderComposition: (spec) =>
          this.renderComposition(manifest, ownerId, spec, signal, opts.onProgress),
        probe: (ref) => this.probe(manifest, ownerId, ref),
        checkVideo: async (ref, request) => {
          const localSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(DELIVERY_CHECK_LIMITS.timeoutMs),
          ])
          return withMediaAbort(localSignal, async () => {
            await this.mediaPath(manifest, ownerId, ref)
            return this.assets.activity.run(() =>
              checkVideo(this.assets, ownerId, ref, request, localSignal, (fraction) =>
                opts.onProgress?.(fraction),
              ),
            )
          })
        },
        analyzeVideo: async (ref, options) => {
          const localSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(SHOT_ANALYSIS_LIMITS.timeoutMs),
          ])
          return withMediaAbort(localSignal, async () => {
            await this.mediaPath(manifest, ownerId, ref)
            if (manifest.permissions.assets !== 'write')
              throw new PermissionError(`插件 ${manifest.id} 没有写资产的权限`)
            return this.assets.activity.run(() =>
              analyzeVideo(this.assets, ownerId, ref, options, localSignal, (fraction) =>
                opts.onProgress?.(fraction),
              ),
            )
          })
        },
        compose: (spec) =>
          this.compose(manifest, ownerId, spec, signal, (f) =>
            opts.onProgress?.(Math.min(1, Math.max(0, f))),
          ),
      },
    }
  }

  compositionRendererIdentity(): string {
    return motionRendererIdentity(mediaToolPaths(), motionChromePath())
  }

  private async renderComposition(
    manifest: PluginManifest,
    ownerId: string,
    spec: { params: Record<string, unknown>; image?: AssetRef; video?: AssetRef },
    signal: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<AssetRef> {
    if (
      manifest.id !== 'plein/core' ||
      !manifest.permissions.media ||
      manifest.permissions.assets !== 'write'
    )
      throw new PermissionError('只有内置动态合成可以启动本地渲染器')
    const parsed = MotionParams.safeParse(spec.params)
    if (!parsed.success)
      throw new ProviderError('invalid_input', '动态合成参数不合法', { retryable: false })
    const inputs: import('../motion/render').MotionInputs = {}
    for (const kind of ['image', 'video'] as const) {
      const ref = spec[kind]
      if (!ref) continue
      const asset = this.assets.get(ownerId, ref.assetId)
      if (!asset || asset.kind !== kind)
        throw new ProviderError(
          'invalid_input',
          `动态合成${kind === 'image' ? '图片' : '视频'}不存在`,
        )
      await this.assets.verifyOriginal(ownerId, asset.id)
      inputs[kind] = {
        assetId: asset.id,
        path: this.assets.originalPath(asset.id),
        mime: asset.mime,
      }
    }
    const dir = await this.assets.tempDir()
    try {
      const out = await renderMotion(parsed.data, inputs, dir, {
        ...mediaToolPaths(),
        signal,
        chromePath: motionChromePath(),
        progress: (event) => onProgress?.(event.percent / 100),
      })
      signal.throwIfAborted()
      const bundle = await this.assets.ingest(ownerId, Readable.from([out.sourceZip]), {
        mime: 'application/zip',
        name: '动态合成源工程.zip',
      })
      const sourceManifest = await this.assets.ingest(
        ownerId,
        Readable.from([Buffer.from(JSON.stringify(out.manifest))]),
        { mime: 'application/json', name: '动态合成来源.json' },
      )
      signal.throwIfAborted()
      const video = await this.assets.ingest(ownerId, createReadStream(out.outputPath), {
        mime: out.mime,
        name: `${parsed.data.title || '动态合成'}.${out.mime === 'video/webm' ? 'webm' : 'mp4'}`,
      })
      return {
        assetId: video.id,
        kind: video.kind,
        mime: video.mime,
        compositionSource: {
          version: 1,
          bundleAssetId: bundle.id,
          manifestAssetId: sourceManifest.id,
          dependencyAssetIds: out.manifest.dependencyAssetIds,
          rendererIdentity: out.identity,
        },
      }
    } catch (error) {
      if (signal.aborted) throw new ProviderError('cancelled', '已取消动态合成')
      if (error instanceof ProviderError) throw error
      throw new ProviderError('unavailable', (error as Error).message, { retryable: false })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** 插件清单（插件已登记） */
  pluginManifest(id: string) {
    return this.manifest(id)
  }

  // ── 内部 ──────────────────────────────────────────

  private async readAsset(manifest: PluginManifest, ownerId: string, ref: AssetRef) {
    if (manifest.permissions.assets === 'none')
      throw new PermissionError(`插件 ${manifest.id} 没有读资产的权限`)
    const asset = this.assets.get(ownerId, ref.assetId)
    if (!asset) throw new ProviderError('invalid_input', `资产 ${ref.assetId} 不存在`)
    const path = this.assets.originalPath(asset.id)
    let videoInfo: Awaited<ReturnType<typeof probeMedia>> | undefined
    if (asset.kind === 'video') {
      try {
        videoInfo = await probeMedia(path)
      } catch {
        // 可选探测信息保持未知；需要这些信息的平台负责拒绝，避免改变其他平台的素材读取契约。
      }
    }
    return {
      ...(videoInfo
        ? {
            videoCodec: videoInfo.videoCodec,
            frameRate: videoInfo.frameRate,
            audioCodecs: videoInfo.audioCodecs,
          }
        : {}),
      data: new Uint8Array(await readFile(path)),
      mime: asset.mime,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
    }
  }

  /** 插件有 media 权限、ffmpeg 可用时，返回资产原文件路径 */
  private async mediaPath(manifest: PluginManifest, ownerId: string, ref: AssetRef) {
    if (!manifest.permissions.media)
      throw new PermissionError(`插件 ${manifest.id} 没有处理媒体的权限`)
    if (!(await hasFfmpeg()))
      throw new ProviderError('unavailable', '没有找到 ffmpeg，无法处理视频和音频', {
        retryable: false,
      })
    const asset = this.assets.get(ownerId, ref.assetId)
    if (!asset) throw new ProviderError('invalid_input', `资产 ${ref.assetId} 不存在`)
    return this.assets.originalPath(asset.id)
  }

  private async probe(
    manifest: PluginManifest,
    ownerId: string,
    ref: AssetRef,
  ): Promise<MediaInfo> {
    return probeMedia(await this.mediaPath(manifest, ownerId, ref))
  }

  private async compose(
    manifest: PluginManifest,
    ownerId: string,
    spec: ComposeSpec,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ): Promise<AssetRef> {
    const parsed = SequenceExportRequest.safeParse({ spec })
    if (!parsed.success)
      throw new ProviderError('invalid_input', '序列合成参数不合法', { retryable: false })
    spec = parsed.data.spec
    const clips = await Promise.all(
      spec.clips.map((c) => this.mediaPath(manifest, ownerId, c.asset)),
    )
    const audio = await Promise.all(
      spec.audio.map((a) => this.mediaPath(manifest, ownerId, a.asset)),
    )
    const overlays = await Promise.all(
      (spec.overlays ?? []).map(async (overlay) => {
        await this.assets.verifyOriginal(ownerId, overlay.asset.assetId)
        if (overlay.asset.compositionSource) {
          const source = CompositionSourceRef.parse(overlay.asset.compositionSource)
          for (const id of [
            source.bundleAssetId,
            source.manifestAssetId,
            ...source.dependencyAssetIds,
          ])
            await this.assets.verifyOriginal(ownerId, id)
        }
        return this.mediaPath(manifest, ownerId, overlay.asset)
      }),
    )
    const [infos, overlayInfos] = await Promise.all([
      Promise.all(clips.map((f) => probeMedia(f))),
      Promise.all(overlays.map((f) => probeMedia(f))),
    ])
    try {
      validateComposeOverlays(spec, overlayInfos, compositionDuration(spec, infos))
    } catch (error) {
      throw new ProviderError('invalid_input', (error as Error).message, { retryable: false })
    }
    if (
      spec.subtitles?.render === 'animated' &&
      spec.subtitles.cues.length &&
      manifest.id !== 'plein/core'
    )
      throw new PermissionError('只有内置序列可以启动动画字幕渲染器')
    const animated = spec.subtitles?.render === 'animated' && spec.subtitles.cues.length
    const captionInput = animated
      ? CaptionLayerParams.safeParse({
          width: spec.width,
          height: spec.height,
          fps: 30,
          duration: compositionDuration(spec, infos),
          cues: spec.subtitles!.cues,
          style: spec.subtitles!.style,
          animation: spec.subtitles!.animation ?? 'pop',
        })
      : undefined
    if (captionInput && !captionInput.success)
      throw new ProviderError(
        'invalid_input',
        compositionDuration(spec, infos) > 300
          ? '动画字幕目前支持最长 300 秒的序列，请缩短序列或使用普通字幕'
          : `动画字幕参数不合法：${captionInput.error.issues[0]?.message ?? '请检查字幕数量、文本与时间'}`,
        { retryable: false },
      )
    const missing = infos.findIndex((i) => !i.hasVideo)
    if (missing >= 0) throw new ProviderError('invalid_input', `第 ${missing + 1} 段不是视频`)
    const dir = await this.assets.tempDir()
    try {
      let renderedSpec = spec
      if (captionInput?.success) {
        const duration = compositionDuration(spec, infos)
        const caption = await renderCaptionLayer(captionInput.data, `${dir}/captions`, {
          ...mediaToolPaths(),
          chromePath: motionChromePath(),
          signal,
          progress: (event) => onProgress((event.percent / 100) * 0.65),
        })
        overlays.push(caption.outputPath)
        overlayInfos.push({
          hasVideo: true,
          hasAudio: false,
          duration,
          videoCodec: 'vp9',
          hasAlpha: true,
        })
        renderedSpec = {
          ...spec,
          overlays: [
            ...(spec.overlays ?? []),
            {
              id: 'plein-captions',
              asset: { assetId: 'internal-caption-layer', kind: 'video', mime: caption.mime },
              start: 0,
              duration,
              in: 0,
              speed: 1,
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              opacity: 1,
            },
          ],
        }
      }
      const { file } = await composeVideo(
        renderedSpec,
        { clips, audio, overlays },
        { clips: infos, overlays: overlayInfos },
        dir,
        {
          signal,
          onProgress: (f) => onProgress(animated ? 0.65 + f * 0.35 : f),
          internalCaptionLayer: Boolean(animated),
        },
      )
      const a = await this.assets.ingest(ownerId, createReadStream(file), {
        mime: 'video/mp4',
        name: `${spec.name ?? '成片'}.mp4`,
      })
      return { assetId: a.id, kind: a.kind, mime: a.mime }
    } catch (err) {
      if (signal.aborted) throw new ProviderError('cancelled', '已取消')
      if (err instanceof ProviderError) throw err
      if (err && typeof err === 'object' && 'retryable' in err && err.retryable === false)
        throw new ProviderError('unavailable', err instanceof Error ? err.message : String(err), {
          retryable: false,
        })
      throw new ProviderError('unknown', (err as Error).message)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  private manifest(plugin: string): PluginManifest {
    return this.registry.plugin(plugin)!.manifest
  }

  private log(plugin: string, message: string, data?: unknown) {
    if (this.opts.log) this.opts.log(plugin, message, data)
    else console.log(`[plugin ${plugin}] ${message}`, data ?? '')
  }
}

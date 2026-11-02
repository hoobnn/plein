import {
  type AssetRef,
  type PortValue,
  ProviderError,
  type ProviderCallResult,
  type ProviderOutput,
} from '@plein/plugin-sdk'
import type { CredentialLost, SubmissionAudit } from '@plein/protocol'
import type { OutputSpoolRef } from '../assets/output-spool'
import { PermissionError } from './sandbox'
import { Agent, Dispatcher1Wrapper } from 'undici'

/**
 * 平台调用的协议层：错误分级、调用记录、结果内嵌与恢复判据。
 * 与「宿主怎么调度平台」无关，所以不放进 host.ts：
 * 任务恢复、字幕配额、智能体工具都要读同一份判据。
 */

/** 异步任务最长等待时间 */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000

/** 结果地址过期或失效（重新查询平台可能拿到新地址） */
export const EXPIRED = new Set([401, 403, 404, 410])

/**
 * 平台请求用的连接池：不设等响应头、读响应体的超时。
 * Node fetch 默认等响应头最多 5 分钟，同步出图在平台排队时会超过，被掐断后成了「提交状态未知」；
 * 一次调用多久算超时由调用超时（signal）统一管
 */
// Electron 内置 fetch 仍使用 undici 7 的处理器协议；包装后兼容 undici 8 的连接池。
const providerDispatcher = new Dispatcher1Wrapper(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))
export const providerFetch = ((input: Request, init?: RequestInit) =>
  fetch(input, { ...init, dispatcher: providerDispatcher } as RequestInit)) as typeof fetch

/** 轮询平台任务的默认间隔 */
export const DEFAULT_POLL_MS = 2_000

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
export type RecordedOutput =
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
export function ambiguous(err: unknown) {
  if (!(err instanceof ProviderError)) return !(err instanceof PermissionError)
  if (err.outcome === 'unknown') return true
  return err.code === 'unknown' || err.code === 'timeout'
}

export function recordOutputs(outputs: ProviderOutput[]): RecordedOutput[] {
  let budget = RECORD_DATA_LIMIT
  return outputs.map((o) => {
    if (o.type !== 'file' || !o.data) return o
    const { data, ...rest } = o
    if (data.byteLength > budget) return { ...rest, dropped: true as const }
    budget -= data.byteLength
    return { ...rest, base64: Buffer.from(data).toString('base64') }
  })
}

export function restoreOutputs(outputs: RecordedOutput[]): ProviderOutput[] | undefined {
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
export function shutdownOnly(signal: AbortSignal | undefined) {
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

export const toError = (err: unknown): ProviderError => {
  if (err instanceof ProviderError) return err
  if (err instanceof PermissionError)
    return new ProviderError('invalid_input', err.message, { cause: err })
  if ((err as Error)?.name === 'AbortError')
    return new ProviderError('cancelled', '已取消', { cause: err })
  return new ProviderError('unknown', (err as Error)?.message ?? String(err), { cause: err })
}

/** 提交状态未知：不自动重试，等核查或人工处理 */
export function unknownSubmit(platform: string, message: string, cause?: unknown) {
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
export function fetchFailed(err: unknown, remoteId: string | undefined, requery: boolean) {
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

export { lostCredential, staged }

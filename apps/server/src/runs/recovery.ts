import { currentResult, type PleinDoc } from '@plein/doc'
import type {
  CanceledBy,
  CredentialLost,
  HeldReason,
  JobRecovery,
  PreparedInput,
  RecoveryState,
} from '@plein/protocol'
import {
  type CallRecord,
  credentialLostOf,
  type FailureStage,
  NodeRunError,
  stageOf,
} from '../plugins/host'
import type { JobRow, JobStatus } from './store'

/**
 * 存在 jobs.recovery 里的恢复状态。界面上看到的 JobRecovery 由它、调用记录和画布现状合成：
 * 候选有没有被采用、平台能不能查询，都在读的时候判断
 */
export interface StoredRecovery {
  state?: RecoveryState
  canceledBy?: CanceledBy
  remoteId?: string
  note?: string
  held?: HeldReason
  resultIds?: string[]
  assets?: string[]
  dismissed?: true
  credentialLost?: CredentialLost
}

export function parseRecovery(raw: string | null | undefined): StoredRecovery {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as StoredRecovery
  } catch {
    return {}
  }
}

export function parseCalls(raw: string | null | undefined): CallRecord[] {
  try {
    return Object.values(JSON.parse(raw ?? '{}') as Record<string, CallRecord>)
  } catch {
    return []
  }
}

/** 平台在恢复上的能力（按插件声明） */
export interface ProviderAbility {
  title: string
  poll: boolean
  /** 有按幂等键查询或幂等提交的合同 */
  verify: boolean
  /** 原密钥失效时，重新提交确认里展示当前组 */
  currentCredentialLabel?: string
}

/** 用户取消、系统取消（删除画布或节点）用的中止原因 */
export const USER_CANCEL = Symbol('plein.cancel.user')
export const SYSTEM_CANCEL = Symbol('plein.cancel.system')

export function canceledByOf(reason: unknown): CanceledBy {
  return reason === SYSTEM_CANCEL ? 'system' : 'user'
}

/** 输入相对批准的计划变了：不提交，等重新审查 */
export function reviewError(reason: string) {
  return new NodeRunError('input_changed', `${reason}，没有提交；请重新查看实际输入后再生成`)
}

const STAGE_STATE: Record<FailureStage, RecoveryState> = {
  submit_unknown: 'submit_unknown',
  fetch_failed: 'fetch_failed',
  remote_failed: 'remote_failed',
  remote_canceled: 'remote_failed',
}

/** 任务结束时记下的恢复状态 */
export function recoveryAfter(
  status: JobStatus,
  err: unknown,
  calls: CallRecord[],
  extra: StoredRecovery = {},
): StoredRecovery | null {
  const out: StoredRecovery = { ...extra }
  const stage = stageOf(err)
  if (stage) out.state = STAGE_STATE[stage]
  const credentialLost = credentialLostOf(err)
  if (credentialLost) out.credentialLost = credentialLost
  // 用户取消过、平台随后也确认停下：仍记为用户取消
  if (stage === 'remote_canceled' && out.canceledBy !== 'user') out.canceledBy = 'remote'
  if ((err as { code?: string } | undefined)?.code === 'input_changed') out.state = 'review'
  const remoteId = (err as { remoteId?: string } | undefined)?.remoteId
  if (remoteId) out.remoteId = remoteId
  if ((status === 'canceled' || status === 'failed') && !out.state) {
    // 不只取消：登记错误可能没有stage；以持久calls兜底，不能把已发送/已生成误作未提交。
    const pending = calls.find((c) => c.state === 'pending')
    if (pending?.state === 'pending') {
      out.state = 'remote_pending'
      out.remoteId = pending.remoteId
    } else if (calls.some((c) => c.state === 'unknown' || c.state === 'submitting'))
      out.state = 'submit_unknown'
    else if (calls.some((c) => c.state === 'fetched')) out.state = 'fetch_failed'
  }
  return Object.keys(out).length ? out : null
}

/**
 * 任务面板里的恢复状态：
 * - 排队、运行中：平台已受理时是 remote_pending；
 * - 成功：看画布上这次的结果是不是当前采用的（adopted / stored）；
 * - 失败、取消：按记下的状态，补上平台能不能查询、能不能重新获取
 */
export function describeRecovery(
  row: JobRow,
  ctx: {
    doc?: PleinDoc
    provider?: ProviderAbility
  },
): { recovery?: JobRecovery; canceledBy?: CanceledBy } {
  const stored = parseRecovery(row.recovery)
  const calls = parseCalls(row.calls)
  const canceledBy =
    stored.canceledBy ?? (row.status === 'canceled' ? ('user' as const) : undefined)
  const base = {
    ...(canceledBy && row.status === 'canceled' ? { canceledBy } : {}),
  }
  const provider = ctx.provider
  const credentialLabel = stored.credentialLost
    ? calls.find((call) => call.credentialLabel)?.credentialLabel
    : undefined
  const remoteOf = () =>
    stored.remoteId ??
    calls.flatMap((c) =>
      (c.state === 'pending' || c.state === 'fetched' || c.state === 'done') && c.remoteId
        ? [c.remoteId]
        : [],
    )[0]
  const common = (state: RecoveryState): JobRecovery => {
    const remoteId = remoteOf()
    return {
      state,
      ...(remoteId ? { remoteId } : {}),
      ...(provider ? { provider: provider.title } : {}),
      ...(stored.note ? { note: stored.note } : {}),
      ...(stored.dismissed ? { dismissed: true as const } : {}),
      ...(stored.credentialLost ? { credentialLost: stored.credentialLost } : {}),
      ...(credentialLabel ? { credentialLabel } : {}),
      ...(stored.credentialLost && provider?.currentCredentialLabel
        ? { currentCredentialLabel: provider.currentCredentialLabel }
        : {}),
    }
  }

  if (row.status === 'queued' || row.status === 'running') {
    const pending = calls.find((c) => c.state === 'pending')
    if (pending?.state !== 'pending') return base
    return { ...base, recovery: { ...common('remote_pending'), remoteId: pending.remoteId } }
  }

  if (stored.state === 'stored' || stored.state === 'adopted' || row.status === 'succeeded') {
    const el = ctx.doc?.get(row.node_id)
    const mine = (el?.results ?? []).filter((r) => r.runId === row.id).map((r) => r.id)
    const resultIds = mine.length ? mine : (stored.resultIds ?? [])
    if (!resultIds.length && !stored.assets?.length) {
      // 早于恢复状态的成功任务、结果已被清掉：不给状态
      if (!stored.state) return base
    }
    // 旧文档的首个待采用候选可能没有 adopted 字段，不能用“默认最新”覆盖入库记录。
    const adopted =
      !!el &&
      (stored.state !== 'stored' || typeof el.adopted === 'string') &&
      currentResult(el)?.runId === row.id
    if (adopted) return { ...base, recovery: { ...common('adopted'), resultIds } }
    return {
      ...base,
      recovery: {
        ...common('stored'),
        resultIds,
        held: el ? (stored.held ?? 'superseded') : 'node_deleted',
        ...(stored.assets?.length ? { assets: stored.assets } : {}),
      },
    }
  }

  if (!stored.state) return base
  const state = stored.state
  const el = ctx.doc?.get(row.node_id)
  if (state === 'submit_unknown')
    return {
      ...base,
      recovery: {
        ...common(state),
        verifiable: !!provider?.verify,
        attachable: !!provider?.poll && !!el && !!row.frozen,
        // 有查询或幂等合同：可以让系统再核查一次（按幂等键查，不盲目重新提交）
        refetchable: !!provider?.verify && !!el && !!row.frozen,
        ...(el ? {} : { note: '节点已删除' }),
      },
    }
  if (state === 'fetch_failed' || state === 'remote_pending') {
    const fetched = calls.find((c) => c.state === 'fetched')
    const hasBytes =
      fetched?.state === 'fetched' &&
      !fetched.outputs.some((o) => o.type === 'file' && 'dropped' in o && o.dropped)
    const canPoll = !!provider?.poll && !!remoteOf()
    const expired = stored.note?.includes('平台不支持重新查询')
    const refetchable = !!el && !!row.frozen && (canPoll || (hasBytes && !expired))
    return {
      ...base,
      recovery: {
        ...common(state),
        refetchable,
        ...(!el ? { note: '节点已删除，无法重新获取' } : {}),
        ...(el && !refetchable && !stored.note
          ? { note: '平台不支持重新查询，结果无法再取回' }
          : {}),
      },
    }
  }
  return { ...base, recovery: common(state) }
}

/** 记录里的模型（取平台能力用） */
export function modelOf(row: JobRow): string | undefined {
  if (!row.input) return undefined
  try {
    return (JSON.parse(row.input) as PreparedInput).model?.ref
  } catch {
    return undefined
  }
}

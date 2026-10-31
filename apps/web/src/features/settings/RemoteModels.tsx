import {
  REMOTE_MODELS_PULL_TIMEOUT_MS,
  type ProviderConfigView,
  type ProviderInfo,
} from '@plein/protocol'
import { useState } from 'react'
import { api } from '../../api/client'
import { fullTime, relativeTime } from '../../ui/format'

/**
 * 平台模型列表区域的远端状态与操作。
 * 覆盖范围非空：显示上次刷新时间、失败原因和「刷新模型列表」，合并结果随目录重载更新；
 * 覆盖范围为空（如兼容渠道）：列表只作「模型 ID」输入框的 datalist 候选。
 * 独立小组件，只在 ProviderRow 里挂载一次，这里不自己保存列表。
 */
export function RemoteModels({
  provider,
  candidates,
  pending = false,
  onRefreshed,
  onConfigReload,
  disabled = false,
  where = 'tags',
}: {
  provider: ProviderInfo
  /**
   * 列表只作候选时的缓存条目（随配置视图返回），由父组件统一维护：
   * 手动刷新后通过 onConfigReload 让父组件重读，本地不缓存以免遮蔽后续结果
   */
  candidates?: ProviderConfigView['remoteModelCandidates']
  /** 保存触发的后台拉取仍在进行（config 视图的 remoteModelsPending） */
  pending?: boolean
  onRefreshed(): void | Promise<void>
  /** 候选平台手动刷新完成后由父组件重读 config 视图，候选随之更新 */
  onConfigReload?: () => unknown
  disabled?: boolean
  /**
   * 挂载位：tags 在模型标签区附近，只服务合并平台（覆盖范围非空）；
   * field 跟在「模型 ID」等设置字段旁，只服务候选平台（覆盖范围为空）。同一时刻只挂一处
   */
  where?: 'tags' | 'field'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!provider.supportsRemoteModels) return null
  const status = provider.remoteModels
  // 合并平台不在字段旁重复渲染，候选平台不在标签区重复渲染
  const emptyScope = (provider.remoteModelsScope?.length ?? 0) === 0
  if ((where === 'tags') === emptyScope) return null
  const shownCandidates = candidates
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.refreshRemoteModels(provider.id)
      // 候选由父组件统一维护：刷新后让父组件重读 config 视图（换密钥组 / 改地址后
      // 服务端按新上下文计算候选，本地缓存旧列表会遮蔽结果）
      await onConfigReload?.()
      await onRefreshed()
    } catch (err) {
      setError(`刷新失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  // 覆盖范围为空：不参与合并，只在设置页给输入框提供候选；
  // datalist 的元素 id 由插件 schema 的 list 字段声明，与 SchemaForm 的 input 对上
  if (emptyScope)
    return (
      <div className="flex flex-col gap-2">
        {declaredListIds(provider).map((id) => (
          <datalist key={id} id={id}>
            {(shownCandidates ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </datalist>
        ))}
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            disabled={busy || disabled || pending}
            onClick={() => void refresh()}
          >
            {busy ? '正在刷新…' : '刷新模型候选'}
          </button>
          <span>
            {pending
              ? '正在后台拉取模型候选，完成后自动更新'
              : (shownCandidates?.length ?? 0) > 0
                ? `渠道返回 ${shownCandidates!.length} 个模型，可在上方「模型 ID」输入框里选用`
                : '渠道的模型列表还没拉取过，刷新后可在「模型 ID」输入框里选用'}
          </span>
          {(error ?? status?.error) && (
            <span className="text-danger" role="alert">
              {error ?? `上次刷新失败：${status?.error}`}
            </span>
          )}
        </div>
      </div>
    )
  const remoteOnly = provider.models.filter((m) => m.remoteOnly).length
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
      <button
        type="button"
        className="ui-btn ui-btn-secondary"
        disabled={busy || disabled}
        onClick={() => void refresh()}
      >
        {busy ? '正在刷新…' : '刷新模型列表'}
      </button>
      <span title={status?.fetchedAt ? fullTime(status.fetchedAt) : undefined}>
        {!status || status.fetchedAt === null
          ? '还没有从平台拉取过模型列表'
          : `上次刷新：${relativeTime(status.fetchedAt)}`}
      </span>
      {pending && <span>正在后台拉取模型列表，完成后自动更新</span>}
      {status?.status === 'stale' && <span>列表已超过 24 小时，建议刷新</span>}
      {remoteOnly > 0 && (
        <span>平台新发现 {remoteOnly} 个模型，参数为通用默认，收录前以平台列表为准</span>
      )}
      {(error ?? status?.error) && (
        <span className="text-danger" role="alert">
          {error ?? `上次刷新失败：${status?.error}`}
        </span>
      )}
    </div>
  )
}

/** 轮询间隔；总窗口按服务端拉取超时（REMOTE_MODELS_PULL_TIMEOUT_MS）推导并留 25% 余量 */
const POLL_INTERVAL_MS = 1500
export const REMOTE_MODELS_POLL_ATTEMPTS =
  Math.ceil((REMOTE_MODELS_PULL_TIMEOUT_MS * 1.25) / POLL_INTERVAL_MS) + 1

/**
 * 等待保存触发的后台拉取结束：轮询 config 视图直到 pending 消失。
 * 超时也返回最后一次读到的视图（可能仍 pending），由调用方刷新目录——
 * 目录重载时后台若已完成，结果随之可见。组件卸载通过 signal 中止，返回 null
 */
export async function awaitRemoteModelsSettled<
  V extends { remoteModelsPending?: boolean } = ProviderConfigView,
>(
  id: string,
  opts: {
    attempts?: number
    delayMs?: number
    signal?: AbortSignal
    getConfig?: (id: string) => Promise<V | undefined>
  } = {},
): Promise<V | null> {
  const attempts = opts.attempts ?? REMOTE_MODELS_POLL_ATTEMPTS
  const delay = opts.delayMs ?? POLL_INTERVAL_MS
  // 默认读真实 config 视图；测试注入更窄的视图形状
  const getConfig: (id: string) => Promise<V | undefined> =
    opts.getConfig ?? ((pid) => api.providerConfig(pid) as unknown as Promise<V>)
  let last: V | undefined
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.signal?.aborted) return null
    await new Promise((ok) => setTimeout(ok, delay))
    if (opts.signal?.aborted) return null
    const view = await getConfig(id)
    // 字段缺省即表示拉取已结束；结束后由调用方重载目录与候选
    if (view && !view.remoteModelsPending) return view
    last = view ?? last
  }
  return last ?? null
}

/** 插件在设置 schema 里声明的 datalist 元素 id（如兼容渠道的「模型 ID」候选） */
function declaredListIds(provider: ProviderInfo): string[] {
  const props = (provider.settingsSchema as { properties?: Record<string, { list?: unknown }> })
    .properties
  return [
    ...new Set(
      Object.values(props ?? {})
        .map((f) => f.list)
        .filter((v): v is string => typeof v === 'string'),
    ),
  ]
}

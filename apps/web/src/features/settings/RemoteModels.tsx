import type { ProviderConfigView, ProviderInfo } from '@plein/protocol'
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
  onRefreshed,
  disabled = false,
}: {
  provider: ProviderInfo
  /** 列表只作候选时的缓存条目（随配置视图返回） */
  candidates?: ProviderConfigView['remoteModelCandidates']
  onRefreshed(): void | Promise<void>
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 刷新后自取最新配置视图：目录重载不更新 ProviderConfigView，候选要自己拿
  const [latest, setLatest] = useState<ProviderConfigView['remoteModelCandidates']>()
  if (!provider.supportsRemoteModels) return null
  const status = provider.remoteModels
  const shownCandidates = latest ?? candidates
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.refreshRemoteModels(provider.id)
      setLatest((await api.providerConfig(provider.id)).remoteModelCandidates)
      await onRefreshed()
    } catch (err) {
      setError(`刷新失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  // 覆盖范围为空：不参与合并，只在设置页给输入框提供候选；
  // datalist 的元素 id 由插件 schema 的 list 字段声明，与 SchemaForm 的 input 对上
  if ((provider.remoteModelsScope?.length ?? 0) === 0)
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
            disabled={busy || disabled}
            onClick={() => void refresh()}
          >
            {busy ? '正在刷新…' : '刷新模型候选'}
          </button>
          <span>
            {(shownCandidates?.length ?? 0) > 0
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

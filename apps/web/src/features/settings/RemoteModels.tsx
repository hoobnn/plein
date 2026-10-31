import type { ProviderInfo } from '@plein/protocol'
import { useState } from 'react'
import { api } from '../../api/client'
import { fullTime, relativeTime } from '../../ui/format'

/**
 * 平台模型列表区域的远端状态：上次刷新时间、失败原因和「刷新模型列表」按钮。
 * 独立小组件，只在 ProviderRow 里挂载一次；刷新成功后由父级重载目录，
 * 合并结果（含目录新模型）随目录一起更新，这里不自己保存列表。
 */
export function RemoteModels({
  provider,
  onRefreshed,
  disabled = false,
}: {
  provider: ProviderInfo
  onRefreshed(): void | Promise<void>
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!provider.supportsRemoteModels) return null
  const status = provider.remoteModels
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.refreshRemoteModels(provider.id)
      await onRefreshed()
    } catch (err) {
      setError(`刷新失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
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
      <span
        title={status?.fetchedAt ? fullTime(status.fetchedAt) : undefined}
      >
        {!status || status.fetchedAt === null
          ? '还没有从平台拉取过模型列表'
          : `上次刷新：${relativeTime(status.fetchedAt)}`}
      </span>
      {status?.status === 'stale' && <span>列表已超过 24 小时，建议刷新</span>}
      {remoteOnly > 0 && (
        <span>
          平台新发现 {remoteOnly} 个模型，参数为通用默认，收录前以平台列表为准
        </span>
      )}
      {(error ?? status?.error) && (
        <span className="text-danger" role="alert">
          {error ?? `上次刷新失败：${status?.error}`}
        </span>
      )}
    </div>
  )
}

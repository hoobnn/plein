import type { CleanupPreview } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Switch } from '../../ui/Switch'
import { queryClient } from '../../api/query'
import { maintenanceApi } from './maintenance-client'

const numberFields = [
  ['intervalHours', '备份间隔（小时）', 1, 720],
  ['keepBackups', '保留最近几份', 1, 100],
  ['unusedDays', '未引用素材保留（天）', 1, 3650],
  ['trashDays', '回收站保留（天）', 1, 365],
] as const
type NumberKey = (typeof numberFields)[number][0]
const statusKey = ['maintenance', 'status'] as const

const bytes = (value: number) => {
  const unit = value >= 1024 ** 3 ? 'GB' : value >= 1024 ** 2 ? 'MB' : 'KB'
  return `${(value / (unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024)).toFixed(1)} ${unit}`
}
const date = (value: number | null) =>
  value == null ? '尚无记录' : new Date(value).toLocaleString('zh-CN', { hour12: false })

/** 设置中的数据维护；接口仅在本机模式开放。 */
export function DataMaintenance() {
  const status = useQuery({
    queryKey: statusKey,
    queryFn: maintenanceApi.status,
    refetchInterval: (query) => (query.state.error ? false : 10_000),
  })
  const space = useQuery({
    queryKey: ['maintenance', 'space'],
    queryFn: maintenanceApi.space,
    retry: false,
  })
  const settings = status.data?.settings
  const [autoBackupDraft, setAutoBackupDraft] = useState<boolean | null>(null)
  const formId = useId()
  const [drafts, setDrafts] = useState<Partial<Record<NumberKey, string>>>({})
  const [invalid, setInvalid] = useState<Partial<Record<NumberKey, boolean>>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [restored, setRestored] = useState<string | null>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const cleanupPreview = useRef<HTMLDivElement>(null)
  const inspectButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (message || error) feedback.current?.scrollIntoView({ block: 'nearest' })
  }, [message, error])
  useEffect(() => {
    if (preview) {
      cleanupPreview.current?.scrollIntoView({ block: 'nearest' })
      cleanupPreview.current?.focus({ preventScroll: true })
    }
  }, [preview])
  const perform = async (
    fn: () => Promise<string | void>,
    options?: { dropsPreview?: boolean },
  ) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    setRestored(null)
    try {
      setMessage((await fn()) ?? null)
      await Promise.all([status.refetch(), space.refetch()])
    } catch (e) {
      setError((e as Error).message)
      // 只有清理这一步失败才作废预检结果：预检的令牌是一次性的，
      // 别的操作失败不该把用户已经看过的「可清理素材」预览一起清掉。
      if (options?.dropsPreview) setPreview(null)
    } finally {
      setBusy(false)
    }
  }
  const retryStatus = (
    <button
      type="button"
      className="ui-btn ui-btn-secondary self-start"
      disabled={busy || status.isFetching}
      onClick={() => void status.refetch()}
    >
      重试读取维护状态
    </button>
  )
  if (!status.data || !settings)
    return (
      <div className="flex flex-col gap-3">
        <p
          role={status.error ? 'alert' : 'status'}
          className={status.error ? 'text-sm text-danger' : 'text-sm text-ink-subtle'}
        >
          {status.error ? `读取维护状态失败：${status.error.message}` : '读取数据维护状态…'}
        </p>
        {status.error && retryStatus}
      </div>
    )
  const locked = busy || status.data.running != null
  const updateNumber = (key: NumberKey, value: string) => {
    setDrafts((previous) => ({ ...previous, [key]: value }))
    setInvalid((previous) => ({ ...previous, [key]: false }))
    setMessage(null)
    setError(null)
  }
  return (
    <div className="flex flex-col gap-6">
      {(locked || message || error || status.error) && (
        <div ref={feedback} className="flex flex-col gap-3">
          {locked && (
            <p role="status" className="text-xs text-ink-subtle">
              维护处理中…
            </p>
          )}
          {message && (
            <p role="status" className="text-xs text-ink-muted">
              {message}
            </p>
          )}
          {restored && (
            <div className="rounded-lg bg-surface-2 p-3 text-xs">
              <p>
                已恢复到：<code className="break-all">{restored}</code>
              </p>
              <p className="mt-2 text-ink-subtle">
                当前数据仍在使用。先关闭 Plein，再以此目录作为 PLEIN_DATA_DIR
                启动服务；桌面端可将副本中的文件复制到原数据目录。不要在运行时覆盖数据库。
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          {status.error && (
            <div className="flex flex-col gap-3">
              <p role="alert" className="text-sm text-danger">
                维护状态更新失败：{status.error.message}
              </p>
              {retryStatus}
            </div>
          )}
        </div>
      )}
      {status.data.skippedSymlinks.length > 0 && (
        <div role="alert" className="rounded-lg bg-surface-2 p-3 text-xs">
          <p>
            以下 {status.data.skippedSymlinks.length}{' '}
            个条目是指向数据目录外的符号链接，已跳过统计、清理和备份：
            {status.data.skippedSymlinks.slice(0, 5).map((path, index) => (
              <span key={path}>
                {index > 0 && '、'}
                <code className="break-all">{path}</code>
              </span>
            ))}
            ；如需纳入管理，请把原文件复制回该位置替换链接。
          </p>
          {status.data.skippedSymlinks.length > 5 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-ink-subtle">
                其余 {status.data.skippedSymlinks.length - 5} 个
              </summary>
              <ul className="mt-1 list-disc pl-5">
                {status.data.skippedSymlinks.slice(5).map((path) => (
                  <li key={path}>
                    <code className="break-all">{path}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <section className="flex flex-col gap-3" aria-label="自动备份">
        <form
          className="flex flex-col gap-3"
          aria-label="维护设置"
          onSubmit={(event) => {
            event.preventDefault()
            const next = { ...settings, autoBackup: autoBackupDraft ?? settings.autoBackup }
            for (const [key] of numberFields)
              if (drafts[key] !== undefined) next[key] = Number(drafts[key])
            void perform(async () => {
              const saved = await maintenanceApi.settings(next)
              // 保存响应可能在关闭重开后才到达；共享状态也必须采用成功保存的值。
              queryClient.setQueryData(statusKey, saved)
              setAutoBackupDraft(null)
              setDrafts({})
              setInvalid({})
              setPreview(null)
              return '维护设置已保存'
            })
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">自动备份</h3>
            <Switch
              label="启用自动备份"
              checked={autoBackupDraft ?? settings.autoBackup}
              disabled={locked}
              onChange={(autoBackup) => {
                setAutoBackupDraft(autoBackup)
                setMessage(null)
                setError(null)
              }}
            />
          </div>
          <p className="text-xs text-ink-subtle">
            备份含全部项目、素材、历史、平台密钥和本机插件，仅保存在本机。服务运行期间按间隔执行；关闭后会在下次启动补做已到期的备份。
          </p>
          <div className="grid grid-cols-2 gap-3">
            {numberFields.map(([key, title, minimum, maximum]) => {
              const id = `${formId}-${key}`
              const hint = `请输入 ${minimum}–${maximum} 之间的整数`
              return (
                <div key={key} className="ui-field">
                  <label htmlFor={id} className="ui-label">
                    {title}
                  </label>
                  <input
                    id={id}
                    className="ui-input w-full"
                    type="number"
                    required
                    step={1}
                    min={minimum}
                    max={maximum}
                    value={drafts[key] ?? settings[key]}
                    disabled={locked}
                    aria-invalid={invalid[key] || undefined}
                    aria-describedby={invalid[key] ? `${id}-error` : undefined}
                    onChange={(event) => {
                      event.currentTarget.setCustomValidity('')
                      updateNumber(key, event.target.value)
                    }}
                    onInvalid={(event) => {
                      event.preventDefault()
                      event.currentTarget.setCustomValidity(hint)
                      setInvalid((previous) => ({ ...previous, [key]: true }))
                      // 焦点留在出错的字段上：用应用自己标的 aria-invalid 找，
                      // 不依赖 :invalid 选择器（各环境支持不一）
                      event.currentTarget.form
                        ?.querySelector<HTMLInputElement>('[aria-invalid="true"]')
                        ?.focus()
                    }}
                  />
                  {invalid[key] && (
                    <span id={`${id}-error`} className="ui-help text-danger">
                      {hint}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-xs text-ink-subtle">
            最近成功：{date(status.data.lastBackupAt)} · 下次：{date(status.data.nextBackupAt)}
          </p>
          {status.data.lastError && (
            <p role="alert" className="text-xs text-danger">
              最近维护失败：{status.data.lastError}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="ui-btn ui-btn-primary" disabled={locked}>
              保存设置
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={locked}
              onClick={() =>
                void perform(async () => {
                  const backup = await maintenanceApi.backup()
                  return `备份完成：${bytes(backup.bytes)}`
                })
              }
            >
              立即备份
            </button>
          </div>
        </form>
      </section>
      <section className="flex flex-col gap-3" aria-label="存储空间">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">存储空间</h3>
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            disabled={locked}
            onClick={() => void space.refetch()}
          >
            刷新
          </button>
        </div>
        {space.error && (
          <p role="status" className="text-xs text-ink-subtle">
            空间统计暂不可用：{space.error.message}
          </p>
        )}
        {space.data && (
          <>
            <p className="text-sm">
              共 {bytes(space.data.total)} · {space.data.assets} 个素材
            </p>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs">
              {(
                [
                  ['原始素材', space.data.originals],
                  ['缩略图及衍生物', space.data.derivatives],
                  ['数据库', space.data.database],
                  ['临时文件', space.data.temporary],
                  ['备份', space.data.backups],
                  ['回收站', space.data.trash],
                  ['恢复的副本', space.data.restored],
                  ['其他', space.data.other],
                ] as const
              ).map(([label, size]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-ink-subtle">{label}</dt>
                  <dd>{bytes(size)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-ink-subtle">
              可回收 {space.data.unusedAssets} 个素材（{bytes(space.data.reclaimableBytes)}
              ）。画布、历史候选、任务、资产库、模板和检查点的引用都会保留。临时文件不参与清理。
            </p>
          </>
        )}
        <button
          ref={inspectButton}
          type="button"
          className="ui-btn ui-btn-secondary self-start"
          disabled={locked}
          onClick={() =>
            void perform(async () => {
              setPreview(await maintenanceApi.preview())
            })
          }
        >
          检查可清理素材
        </button>
        {preview && (
          <div
            ref={cleanupPreview}
            role="region"
            aria-label="清理预览"
            tabIndex={-1}
            className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 text-xs"
          >
            {preview.assets === 0 ? (
              <p role="status">
                暂无可清理素材。被引用或未超过 {preview.unusedDays} 天保留期的素材不会清理。
              </p>
            ) : (
              <>
                <p>
                  将 {preview.assets} 个登记和修改时间都超过 {preview.unusedDays}{' '}
                  天、且未引用的素材（
                  {bytes(preview.bytes)}
                  ）移入回收站。保留 {preview.protectedAssets} 个被引用的素材。
                </p>
                <p className="text-ink-subtle">
                  回收站到期后才释放磁盘空间，到期前可以恢复。确认前数据有变化会要求重新检查。
                </p>
              </>
            )}
            <div className="flex gap-2">
              {preview.assets > 0 && (
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary"
                  disabled={locked}
                  onClick={() =>
                    void perform(
                      async () => {
                        const result = await maintenanceApi.cleanup(preview.token)
                        setPreview(null)
                        return `已将 ${result.assets} 个素材移入回收站`
                      },
                      // 清理的令牌用过即废：失败后必须重新预检，不能拿旧结果再试。
                      { dropsPreview: true },
                    )
                  }
                >
                  确认移入回收站
                </button>
              )}
              <button
                type="button"
                className="ui-btn ui-btn-ghost"
                disabled={locked}
                onClick={() => {
                  setPreview(null)
                  inspectButton.current?.focus()
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2" aria-label="本机备份">
        <h3 className="text-sm font-medium">本机备份</h3>
        {status.data.backups.length === 0 && (
          <p className="text-xs text-ink-subtle">尚无备份，可以先点“立即备份”。</p>
        )}
        {status.data.backups.map((backup) => (
          <div
            key={backup.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-line p-3"
          >
            <span className="min-w-0 text-xs">
              <span className="block">
                {date(backup.createdAt)} · {bytes(backup.bytes)}
              </span>
              <span className="mt-1 block break-all text-ink-subtle">{backup.path}</span>
            </span>
            <button
              type="button"
              className="ui-btn ui-btn-secondary shrink-0"
              disabled={locked}
              onClick={() =>
                void perform(async () => {
                  const copy = await maintenanceApi.restoreCopy(backup.id)
                  setRestored(copy.path)
                  return '完整性校验通过，已恢复到新目录'
                })
              }
            >
              恢复副本
            </button>
          </div>
        ))}
      </section>
      {status.data.trash.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="回收站">
          <h3 className="text-sm font-medium">回收站</h3>
          {status.data.trash.map((trash) => (
            <div
              key={trash.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 text-xs"
            >
              <span>
                {trash.assets} 个素材 · {bytes(trash.bytes)}
                <span className="mt-1 block text-ink-subtle">到期：{date(trash.expiresAt)}</span>
              </span>
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={locked}
                onClick={() =>
                  void perform(async () => {
                    const result = await maintenanceApi.restoreTrash(trash.id)
                    return `已恢复 ${result.assets} 个素材`
                  })
                }
              >
                恢复素材
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

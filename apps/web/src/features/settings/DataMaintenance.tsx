import type { CleanupPreview, MaintenanceSettings } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Switch } from '../../ui/Switch'
import { maintenanceApi } from './maintenance-client'

const bytes = (value: number) => {
  const unit = value >= 1024 ** 3 ? 'GB' : value >= 1024 ** 2 ? 'MB' : 'KB'
  return `${(value / (unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : 1024)).toFixed(1)} ${unit}`
}
const date = (value: number | null) =>
  value == null ? '尚无记录' : new Date(value).toLocaleString()

/** 设置中的数据维护；接口仅在本机模式开放。 */
export function DataMaintenance() {
  const status = useQuery({
    queryKey: ['maintenance', 'status'],
    queryFn: maintenanceApi.status,
    refetchInterval: 10_000,
  })
  const space = useQuery({
    queryKey: ['maintenance', 'space'],
    queryFn: maintenanceApi.space,
    retry: false,
  })
  const [settings, setSettings] = useState<MaintenanceSettings | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [restored, setRestored] = useState<string | null>(null)
  useEffect(() => {
    if (status.data && !settings) setSettings(status.data.settings)
  }, [status.data, settings])
  const perform = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      setMessage((await fn()) ?? null)
      await Promise.all([status.refetch(), space.refetch()])
    } catch (e) {
      setError((e as Error).message)
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }
  if (status.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {status.error.message}
      </p>
    )
  if (!status.data || !settings)
    return (
      <p role="status" className="text-sm text-ink-subtle">
        读取数据维护状态…
      </p>
    )
  const locked = busy || status.data.running != null
  const updateNumber = (
    key: 'intervalHours' | 'keepBackups' | 'unusedDays' | 'trashDays',
    value: string,
  ) => setSettings({ ...settings, [key]: Number(value) })
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="自动备份">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">自动备份</h3>
          <Switch
            label="启用自动备份"
            checked={settings.autoBackup}
            disabled={locked}
            onChange={(autoBackup) => setSettings({ ...settings, autoBackup })}
          />
        </div>
        <p className="text-xs text-ink-subtle">
          备份含全部项目、素材、历史、平台密钥和本机插件，仅保存在本机。服务运行期间按间隔执行；关闭后会在下次启动补做已到期的备份。
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="ui-field">
            <span className="ui-label">备份间隔（小时）</span>
            <input
              className="ui-input w-full"
              type="number"
              min={1}
              max={720}
              value={settings.intervalHours}
              disabled={locked}
              onChange={(e) => updateNumber('intervalHours', e.target.value)}
            />
          </label>
          <label className="ui-field">
            <span className="ui-label">保留最近几份</span>
            <input
              className="ui-input w-full"
              type="number"
              min={1}
              max={100}
              value={settings.keepBackups}
              disabled={locked}
              onChange={(e) => updateNumber('keepBackups', e.target.value)}
            />
          </label>
          <label className="ui-field">
            <span className="ui-label">未引用素材保留（天）</span>
            <input
              className="ui-input w-full"
              type="number"
              min={1}
              max={3650}
              value={settings.unusedDays}
              disabled={locked}
              onChange={(e) => updateNumber('unusedDays', e.target.value)}
            />
          </label>
          <label className="ui-field">
            <span className="ui-label">回收站保留（天）</span>
            <input
              className="ui-input w-full"
              type="number"
              min={1}
              max={365}
              value={settings.trashDays}
              disabled={locked}
              onChange={(e) => updateNumber('trashDays', e.target.value)}
            />
          </label>
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
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={locked}
            onClick={() =>
              void perform(async () => {
                await maintenanceApi.settings(settings)
                setPreview(null)
                return '维护设置已保存'
              })
            }
          >
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
          <div className="flex flex-col gap-2 rounded-lg bg-surface-2 p-3 text-xs">
            <p>
              将 {preview.assets} 个登记和修改时间都超过 {preview.unusedDays} 天、且未引用的素材（
              {bytes(preview.bytes)}
              ）移入回收站。保留 {preview.protectedAssets} 个被引用的素材。
            </p>
            <p className="text-ink-subtle">
              回收站到期后才释放磁盘空间，到期前可以恢复。确认前数据有变化会要求重新检查。
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                disabled={locked || preview.assets === 0}
                onClick={() =>
                  void perform(async () => {
                    const result = await maintenanceApi.cleanup(preview.token)
                    setPreview(null)
                    return `已将 ${result.assets} 个素材移入回收站`
                  })
                }
              >
                确认移入回收站
              </button>
              <button
                type="button"
                className="ui-btn ui-btn-ghost"
                onClick={() => setPreview(null)}
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
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

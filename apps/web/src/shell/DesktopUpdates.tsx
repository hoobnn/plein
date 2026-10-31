import type {
  DesktopUpdateIntervalHours,
  DesktopUpdatePreferences,
  DesktopUpdateState,
} from '@plein/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { desktop } from '../desktop'
import { bytes, duration, relativeTime, shortTime } from '../ui/format'
import { Icon, type IconName } from '../ui/icons'
import { Modal, ModalHeader } from '../ui/Modal'
import { Presence, useExit } from '../ui/Presence'
import { Select, type SelectOption } from '../ui/Select'
import { Switch } from '../ui/Switch'
import { renderReleaseNotes } from './releaseNotes'
import { useUpdate, type UpdateAction as Action } from './desktopUpdateState'

/** 应用打开期间的检查频率；0 表示不定期检查 */
const INTERVAL_LABELS: Record<DesktopUpdateIntervalHours, string> = {
  0: '不定期',
  1: '每小时',
  3: '每 3 小时',
  6: '每 6 小时',
  12: '每 12 小时',
  24: '每天',
}
const INTERVAL_OPTIONS: SelectOption[] = Object.entries(INTERVAL_LABELS).map(([value, label]) => ({
  value,
  label,
}))

const intervalText = (hours: DesktopUpdateIntervalHours) =>
  hours === 0 ? '不定期检查' : `${INTERVAL_LABELS[hours]}检查一次`

async function act(action: Action | 'read') {
  if (!desktop || useUpdate.getState().pending) return
  const previous = useUpdate.getState().state
  useUpdate.setState({ pending: action, bridgeError: null })
  try {
    if (action === 'read') {
      const snapshot = await desktop.getUpdateState()
      if (useUpdate.getState().state === previous) useUpdate.setState({ state: snapshot })
    } else if (action === 'check') await desktop.checkForUpdates()
    else if (action === 'download') await desktop.downloadUpdate()
    else await desktop.installUpdate()
  } catch (err) {
    if (action !== 'read' || useUpdate.getState().state === previous)
      useUpdate.setState({ bridgeError: err instanceof Error ? err.message : String(err) })
  } finally {
    useUpdate.setState({ pending: null })
  }
}

/** 读取主进程保存的检查偏好；失败时抛出，由调用方给出重试入口 */
async function readPreferences(): Promise<void> {
  if (!desktop) return
  const preferences = await desktop.getUpdatePreferences()
  useUpdate.setState({ preferences, bridgeError: null })
}

/** 保存偏好；主进程会校验取值，失败时抛出并保留原设置 */
async function writePreferences(preferences: DesktopUpdatePreferences): Promise<void> {
  if (!desktop) return
  const saved = await desktop.setUpdatePreferences(preferences)
  useUpdate.setState({ preferences: saved, bridgeError: null })
}

/** 相对时间要跟着走：每半分钟重新算一次，跨过午夜也跟着变 */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** 全局监听与完整快照配合，主进程先完成下载、页面后挂载也能恢复。 */
export function DesktopUpdates() {
  const { state, open } = useUpdate()
  const [dismissed, setDismissed] = useState('')
  useEffect(() => {
    if (!desktop) return
    let alive = true
    let received = false
    const offState = desktop.onUpdateState((state) => {
      received = true
      useUpdate.setState({ state, bridgeError: null })
    })
    void desktop.getUpdateState().then(
      (state) => {
        if (alive && !received) useUpdate.setState({ state })
      },
      (err) => {
        if (alive && !received)
          useUpdate.setState({ bridgeError: err instanceof Error ? err.message : String(err) })
      },
    )
    return () => {
      alive = false
      offState()
    }
  }, [])
  const notice =
    state &&
    (['available', 'downloading', 'downloaded'].includes(state.phase) ||
      (state.phase === 'error' && state.error?.operation !== 'check'))
  const key = `${state?.release?.version}:${state?.phase}`
  return (
    <>
      <Presence>
        {notice && !open && dismissed !== key && (
          <UpdateNotice state={state} onDismiss={() => setDismissed(key)} />
        )}
      </Presence>
      <Presence>
        {open && (
          <Modal
            label="应用更新"
            top
            isolateKeys
            onClose={() => useUpdate.setState({ open: false })}
            className="max-w-150"
          >
            <ModalHeader title="应用更新" onClose={() => useUpdate.setState({ open: false })} />
            <div className="flex min-h-0 flex-col p-5">
              <UpdateContent scroll />
            </div>
          </Modal>
        )}
      </Presence>
    </>
  )
}

const statusOf = (state: DesktopUpdateState): { title: string; hint: string; icon: IconName } => {
  switch (state.phase) {
    case 'unavailable':
      return {
        title: '此版本不支持自动更新',
        hint: state.reason ?? '请从发布页面下载更新。',
        icon: 'info',
      }
    case 'idle':
      return {
        title: state.checkedAt ? '已经是最新版本' : '让 Plein 保持最新',
        hint: '自动检查新版本，下载前可先查看更新内容。',
        icon: state.checkedAt ? 'check' : 'download',
      }
    case 'checking':
      return { title: '正在检查更新…', hint: '正在获取最新版本与更新内容。', icon: 'retry' }
    case 'available':
      return { title: '发现新版本', hint: '查看下方更新内容，准备好后即可下载。', icon: 'retry' }
    case 'downloading':
      return {
        title: (state.progress?.percent ?? 0) >= 100 ? '正在校验更新包…' : '正在下载更新',
        hint: '可以关闭此面板，下载会在后台继续。',
        icon: 'download',
      }
    case 'downloaded':
      return {
        title: '更新已准备好',
        hint: '重启 Plein 即可完成安装；稍后退出时也会自动安装。',
        icon: 'check',
      }
    case 'error':
      return {
        title:
          state.error?.operation === 'download'
            ? '更新下载失败'
            : state.error?.operation === 'install'
              ? '更新安装未完成'
              : '检查更新失败',
        hint:
          state.error?.operation === 'install'
            ? '可以重试安装，更新内容会继续保留。'
            : '请检查网络连接后重试。',
        icon: 'warning',
      }
  }
}

/** 设置和菜单共用同一内容，关闭面板不丢失说明或下载状态。 */
export function UpdateContent({ scroll = false }: { scroll?: boolean } = {}) {
  const { state, pending, bridgeError, preferences } = useUpdate()
  if (!state)
    return (
      <div className="flex flex-col gap-3 text-sm text-ink-muted">
        <p role={bridgeError ? 'alert' : 'status'}>{bridgeError ?? '正在读取更新状态…'}</p>
        {bridgeError && (
          <button
            type="button"
            className="ui-btn ui-btn-secondary self-start"
            disabled={!!pending}
            onClick={() => void act('read')}
          >
            重试读取
          </button>
        )}
      </div>
    )
  const status = statusOf(state)
  const { release, phase } = state
  const action: Action | null =
    phase === 'downloaded' || (phase === 'error' && state.error?.operation === 'install')
      ? 'install'
      : phase === 'available' ||
          (phase === 'error' && state.error?.operation === 'download' && !!release)
        ? 'download'
        : phase === 'idle' || phase === 'error'
          ? 'check'
          : null
  const date =
    release?.date && Number.isFinite(Date.parse(release.date))
      ? new Date(release.date).toLocaleDateString('zh-CN')
      : null
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-5">
      <div
        className={`flex min-h-0 flex-col gap-5 ${scroll ? 'ui-scrollbar overflow-y-auto pr-1' : ''}`}
      >
        <section
          className="flex flex-col gap-4 rounded-xl border border-line bg-surface-2 p-4"
          aria-label="更新状态"
        >
          <div className="flex items-start gap-3">
            <span className={`mt-0.5 ${phase === 'error' ? 'text-danger' : 'text-accent'}`}>
              {phase === 'checking' ? (
                <span className="ui-spinner size-5" />
              ) : (
                <Icon name={status.icon} size={20} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p role="status" className="font-semibold">
                {status.title}
              </p>
              <p className="mt-1 text-sm leading-6 text-ink-muted">{status.hint}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
            <span className="text-ink-muted">当前版本 {state.currentVersion}</span>
            {release && (
              <>
                <Icon name="chevronRight" size={14} />
                <strong className="font-medium">{release.version}</strong>
              </>
            )}
            {date && <span className="text-xs text-ink-subtle">{date} 发布</span>}
          </div>
          {phase === 'downloading' && <DownloadProgress state={state} />}
          {(state.error || bridgeError) && (
            <p role="alert" className="max-h-28 overflow-auto text-sm break-words text-danger">
              {bridgeError ?? state.error?.message}
            </p>
          )}
        </section>

        <UpdateSchedule state={state} />

        {release && (
          <section className="flex min-w-0 flex-col gap-3" aria-label="更新内容">
            <h3 className="text-sm font-semibold">{release.name || '此版本的新内容'}</h3>
            {release.notes.length ? (
              release.notes.map((entry) => (
                <article key={`${entry.version}:${entry.note}`} className="min-w-0">
                  {release.notes.length > 1 && (
                    <h4 className="mb-2 text-sm font-semibold">{entry.version}</h4>
                  )}
                  <ReleaseNote note={entry.note} />
                </article>
              ))
            ) : (
              <p className="text-sm leading-6 text-ink-muted">
                此版本暂未提供更新说明，你仍可继续下载更新。
              </p>
            )}
            <a
              className="self-start text-xs text-accent hover:underline"
              href={`https://github.com/hoobnn/plein/releases/tag/v${encodeURIComponent(release.version)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              在浏览器中查看完整发布说明 ↗
            </a>
          </section>
        )}
      </div>
      <div className="flex flex-none flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-xs text-ink-subtle">
          {phase === 'unavailable'
            ? '此环境不会自动检查更新'
            : preferences
              ? `${preferences.checkOnLaunch ? '启动时检查' : '启动时不检查'} · ${intervalText(preferences.intervalHours)}`
              : '自动检查更新'}
        </p>
        {action && (
          <button
            type="button"
            disabled={!!pending}
            className={`ui-btn ${action === 'check' ? 'ui-btn-secondary' : 'ui-btn-primary'}`}
            onClick={() => void act(action)}
          >
            <Icon
              name={action === 'install' ? 'retry' : action === 'download' ? 'download' : 'retry'}
            />
            {pending
              ? '正在处理…'
              : action === 'install'
                ? '重启并安装'
                : action === 'download'
                  ? phase === 'error'
                    ? '重试下载'
                    : '下载更新'
                  : phase === 'error'
                    ? '重试检查'
                    : '检查更新'}
          </button>
        )}
        {phase === 'checking' && <span className="text-sm text-ink-muted">检查中…</span>}
      </div>
    </div>
  )
}

/** 自动检查计划：启动时是否检查、应用打开期间多久检查一次 */
function UpdateSchedule({ state }: { state: DesktopUpdateState }) {
  const preferences = useUpdate((s) => s.preferences)
  const [error, setError] = useState<string | null>(null)
  const now = useNow()
  const load = useCallback(async () => {
    try {
      await readPreferences()
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  useEffect(() => {
    if (!preferences) void load()
  }, [preferences, load])
  const save = async (next: DesktopUpdatePreferences) => {
    try {
      await writePreferences(next)
    } catch (err) {
      useUpdate.setState({ bridgeError: err instanceof Error ? err.message : String(err) })
    }
  }
  if (!preferences)
    return error ? (
      <section
        className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4"
        aria-label="更新检查计划"
      >
        <p role="alert" className="text-sm break-words text-danger">
          读取检查偏好失败：{error}
        </p>
        <button
          type="button"
          className="ui-btn ui-btn-secondary self-start"
          onClick={() => void load()}
        >
          重试读取
        </button>
      </section>
    ) : null
  // 当前环境不提供自动更新，偏好只对正式版生效，这里不让改。
  const unavailable = state.phase === 'unavailable'
  return (
    <section
      className="flex flex-col gap-4 rounded-xl border border-line bg-surface-2 p-4"
      aria-label="更新检查计划"
    >
      {unavailable && (
        <p className="text-xs text-ink-subtle">当前环境不提供自动更新，这里的设置在正式版生效。</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">启动时自动检查更新</p>
          <p className="mt-0.5 text-xs text-ink-subtle">打开 Plein 后自动检查新版本</p>
        </div>
        <Switch
          label="启动时自动检查更新"
          disabled={unavailable}
          checked={preferences.checkOnLaunch}
          onChange={(next) => void save({ ...preferences, checkOnLaunch: next })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">应用打开期间检查频率</p>
          <p className="mt-0.5 text-xs text-ink-subtle">应用开着的时候多久查一次新版本</p>
        </div>
        <Select
          aria-label="应用打开期间检查频率"
          disabled={unavailable}
          value={String(preferences.intervalHours)}
          options={INTERVAL_OPTIONS}
          onChange={(value) =>
            void save({
              ...preferences,
              intervalHours: Number(value) as DesktopUpdateIntervalHours,
            })
          }
        />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-subtle">
        <span>
          {state.checkedAt
            ? `上次检查：${relativeTime(state.checkedAt, now)}`
            : '上次检查：还没有检查过'}
        </span>
        <span>
          {state.nextCheckAt
            ? `下次检查：${shortTime(state.nextCheckAt)}`
            : preferences.intervalHours === 0
              ? '下次检查：不定期'
              : '下次检查：暂无安排'}
        </span>
      </div>
    </section>
  )
}

function ReleaseNote({ note }: { note: string }) {
  const html = useMemo(() => renderReleaseNotes(note), [note])
  const className = 'plein-md text-sm break-words text-ink-muted [&_pre]:max-w-full'
  // oxlint-disable-next-line react/no-danger -- Markdown 禁止 HTML，feed HTML 经白名单重建。
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

function DownloadProgress({
  state,
  compact = false,
}: {
  state: DesktopUpdateState
  compact?: boolean
}) {
  const p = state.progress
  const percent = p ? Math.floor(Math.max(0, Math.min(100, p.percent))) : 0
  const determinate = p && p.total > 0
  const remaining =
    p && p.bytesPerSecond > 0 && p.total > p.transferred
      ? ((p.total - p.transferred) / p.bytesPerSecond) * 1000
      : null
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex justify-between gap-3 text-xs text-ink-muted tabular-nums">
        <span>
          {p
            ? p.total > 0
              ? `${bytes(p.transferred)} / ${bytes(p.total)}`
              : `${bytes(p.transferred)} 已下载`
            : '准备下载…'}
        </span>
        <span>{determinate ? `${percent}%` : '等待下载进度'}</span>
      </div>
      <span
        className="ui-run-step-bar bg-accent-soft"
        role="progressbar"
        aria-label="更新下载进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={determinate ? percent : undefined}
      >
        <i style={{ width: `${determinate ? percent : 0}%` }} />
      </span>
      {!compact && p && (
        <p className="flex flex-wrap justify-between gap-2 text-xs text-ink-subtle tabular-nums">
          <span>
            {p.bytesPerSecond > 0
              ? `${bytes(p.bytesPerSecond)}/s`
              : percent >= 100
                ? '正在校验更新包…'
                : '正在等待数据…'}
          </span>
          {remaining !== null && <span>约剩余 {duration(remaining)}</span>}
        </p>
      )}
    </div>
  )
}

function UpdateNotice({ state, onDismiss }: { state: DesktopUpdateState; onDismiss(): void }) {
  const status = statusOf(state)
  return (
    <aside
      {...useExit()}
      className="ui-pop ui-pop-up fixed right-4 bottom-4 z-30 flex w-80 max-w-[calc(100%-2rem)] flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-3"
      aria-label="应用更新提醒"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-accent">
          <Icon name={status.icon} />
        </span>
        <div className="min-w-0 flex-1">
          <p role="status" className="text-sm font-medium">
            {status.title}
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">Plein {state.release?.version}</p>
        </div>
        <button
          type="button"
          className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
          aria-label="收起更新提醒"
          onClick={onDismiss}
        >
          <Icon name="x" size={14} />
        </button>
      </div>
      {state.phase === 'downloading' && <DownloadProgress state={state} compact />}
      <button
        type="button"
        className="ui-btn ui-btn-secondary ui-btn-sm self-end"
        onClick={() => useUpdate.setState({ open: true })}
      >
        {state.phase === 'downloaded'
          ? '查看并安装'
          : state.phase === 'error'
            ? '查看并重试'
            : '查看更新'}
      </button>
    </aside>
  )
}

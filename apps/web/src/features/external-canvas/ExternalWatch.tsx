import { useEffect } from 'react'
import { create } from 'zustand'
import type { ExternalTarget } from '@plein/protocol'
import { api } from '../../api/client'
import { useCanvas } from '../../stores/canvas'
import { Switch } from '../../ui/Switch'

interface Watch {
  canvasId: string
  target: ExternalTarget
}

const useWatch = create<{ active: Watch | null; message: string }>(() => ({
  active: null,
  message: '',
}))

/** Send the revision shown by the preview. Every write rechecks both sides at the normal apply endpoint. */
export async function syncLinked(watch: Watch, signal: AbortSignal) {
  const { canvasId, target } = watch
  const preview = await api.externalCanvasPreview(canvasId, target, signal)
  let applied = 0
  let attention = 0
  for (const row of preview.rows) {
    signal.throwIfAborted()
    if (row.state === 'synced' || row.state === 'local-only' || row.state === 'remote-only')
      continue
    const action =
      row.state === 'remote-changed' ? 'pull' : row.state === 'local-changed' ? 'push' : null
    if (!action || !row.actions.includes(action)) {
      attention++
      continue
    }
    await api.externalCanvasApply(canvasId, {
      ...target,
      action,
      rowId: row.rowId,
      revision: row.revision,
    })
    applied++
  }
  return { applied, attention }
}

export function ExternalWatcher({ canvasId }: { canvasId: string }) {
  const active = useWatch((s) => s.active)
  useEffect(
    () => () => {
      if (useWatch.getState().active?.canvasId === canvasId)
        useWatch.setState({ active: null, message: '' })
    },
    [canvasId],
  )
  useEffect(() => {
    if (!active || active.canvasId !== canvasId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let lastNotice = ''
    async function cycle() {
      if (controller.signal.aborted || !active) return
      try {
        const canvas = useCanvas.getState()
        if (
          canvas.canvasId === canvasId &&
          canvas.sync === 'connected' &&
          !canvas.engine?.doc.readOnly
        ) {
          const { applied, attention } = await syncLinked(active, controller.signal)
          controller.signal.throwIfAborted()
          const message = attention
            ? `有 ${attention} 项需要在即梦同步面板核对`
            : applied
              ? `已同步 ${applied} 项改动`
              : '已检查，两端没有待传递的改动'
          useWatch.setState({ message })
          if (attention && message !== lastNotice) canvas.notify(message)
          lastNotice = attention ? message : ''
        } else useWatch.setState({ message: '等待 Plein 画布连接' })
      } catch (err) {
        if (controller.signal.aborted) return
        const message = err instanceof Error ? err.message : '同步请求失败'
        useWatch.setState({ message })
        if (message !== lastNotice) useCanvas.getState().notify('即梦同步 · ' + message)
        lastNotice = message
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void cycle(), 30_000)
    }
    void cycle()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [active, canvasId])
  return null
}

export function ExternalWatchControl({
  canvasId,
  target,
}: {
  canvasId: string
  target?: ExternalTarget
}) {
  const { active, message } = useWatch()
  const watching = active?.canvasId === canvasId ? active : null
  if (!watching && !target) return null
  const shown = target ?? watching!.target
  const enabled =
    active?.canvasId === canvasId &&
    active.target.provider === shown.provider &&
    active.target.target === shown.target
  return (
    <div className="flex items-center justify-between gap-4 border-t border-line px-4 py-3 sm:px-5">
      <div>
        <p className="text-sm font-medium">编辑时同步已关联节点</p>
        <p className="text-xs text-ink-muted">
          每 30 秒检查一次。仅传递单侧修改，冲突留待核对。离开此画布即停止。
        </p>
        {watching && (
          <p className="mt-1 text-xs text-ink-muted wrap-anywhere">
            同步目标 · {watching.target.target}
          </p>
        )}
        {watching && !enabled && (
          <button
            className="ui-btn ui-btn-quiet ui-btn-sm"
            type="button"
            onClick={() => useWatch.setState({ active: null, message: '' })}
          >
            停止当前同步
          </button>
        )}
        {watching && message && <p className="mt-1 text-xs text-ink-muted">{message}</p>}
      </div>
      <Switch
        label="编辑时同步已关联节点"
        checked={enabled}
        onChange={(next) =>
          useWatch.setState({ active: next ? { canvasId, target: shown } : null, message: '' })
        }
      />
    </div>
  )
}

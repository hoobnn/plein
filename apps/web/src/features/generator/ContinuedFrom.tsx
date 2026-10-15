import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { useState } from 'react'
import {
  continuePointLabel,
  continuesFromOf,
  continueStale,
  refreshContinue,
} from '../../canvas/continueShot'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'

/**
 * 续镜节点的来路：「续自 镜头 3 · 尾帧」，点一下回到上一个镜头。
 * 上一个镜头重新生成过而首帧还是旧画面时提示，并能一键换成新画面。
 */
export function ContinuedFrom({ engine, el }: { engine: Engine; el: CanvasElement }) {
  const [busy, setBusy] = useState(false)
  const from = continuesFromOf(el)
  if (!from) return null
  const parent = engine.doc.get(from.elementId)
  const stale = continueStale(engine, el.id)
  const locate = () => {
    if (!parent) return
    engine.selection.set([parent.id])
    engine.zoomToFit([parent.id, el.id])
  }
  const refresh = async () => {
    setBusy(true)
    try {
      await refreshContinue(engine, el.id)
      useCanvas.getState().notify('已换成上一个镜头的新画面')
    } catch (err) {
      useCanvas.getState().notify((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 px-4 pt-3 text-xs text-ink-subtle"
      data-testid="continued-from"
    >
      <Icon name="continueShot" size={14} />
      <span className="flex-none">续自</span>
      {parent ? (
        <button
          type="button"
          className="ui-chip min-w-0 transition-colors hover:text-ink"
          title="回到上一个镜头"
          onClick={locate}
        >
          <span className="truncate">
            {parent.name ?? '视频'} · {continuePointLabel(from)}
          </span>
        </button>
      ) : (
        <span className="truncate">已删除的视频 · {continuePointLabel(from)}</span>
      )}
      {stale && (
        <>
          <span
            className="flex min-w-0 items-center gap-1 text-warning"
            title="上一个镜头重新生成过，首帧还是旧画面"
          >
            <Icon name="warning" size={14} />
            <span className="truncate">首帧已旧</span>
          </span>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-quiet ml-auto flex-none"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? '取帧中…' : '换成新画面'}
          </button>
        </>
      )}
    </div>
  )
}

import type { Engine } from '@plein/canvas-core'
import { type CanvasElement, videoAssetOf } from '@plein/doc'
import {
  continuePointLabel,
  continuesFromOf,
  continueStale,
  refreshContinue,
} from '../../canvas/continueShot'
import { useCanvas } from '../../stores/canvas'
import { Icon } from '../../ui/icons'
import { beginContinueRequest, continueRequestKey, useContinueRequest } from './continueRequests'

/**
 * 续镜节点的来路：「续自 镜头 3 · 尾帧」，点一下回到上一个镜头。
 * 上一个镜头重新生成过而首帧还是旧画面时提示，并能一键换成新画面。
 */
export function ContinuedFrom({ engine, el }: { engine: Engine; el: CanvasElement }) {
  const from = continuesFromOf(el)
  const parent = from ? engine.doc.get(from.elementId) : undefined
  const assetId = videoAssetOf(parent) ?? ''
  const requestKey = continueRequestKey(engine, 'refresh', el.id, assetId)
  const continuation = useContinueRequest(requestKey)
  const { pending } = continuation
  const busy = !!pending
  if (!from) return null
  const stale = continueStale(engine, el.id)
  const locate = () => {
    if (!parent) return
    engine.selection.set([parent.id])
    engine.zoomToFit([parent.id, el.id])
  }
  const refresh = async () => {
    const request = beginContinueRequest(engine, requestKey)
    if (!request) return
    const current = () =>
      request.current() &&
      !!engine.doc.get(el.id) &&
      videoAssetOf(engine.doc.get(from.elementId)) === assetId
    try {
      await refreshContinue(engine, el.id, request.signal)
      if (current() && !request.signal.aborted)
        useCanvas.getState().notify('已换成上一个镜头的新画面')
    } catch (err) {
      if (current())
        useCanvas.getState().notify(request.signal.aborted ? '已取消取帧' : (err as Error).message)
    } finally {
      request.finish()
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
            ref={continuation.trigger}
            onClick={() => void refresh()}
          >
            {busy ? '取帧中…' : '换成新画面'}
          </button>
          {busy && (
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-quiet"
              disabled={pending.signal.aborted}
              onClick={(event) => continuation.cancel(event.currentTarget)}
            >
              {pending.signal.aborted ? '取消中…' : '取消取帧'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

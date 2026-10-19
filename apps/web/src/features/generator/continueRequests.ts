import type { Engine } from '@plein/canvas-core'
import { create } from 'zustand'
import { useLayoutEffect, useRef } from 'react'
import { useCanvas } from '../../stores/canvas'

export const continueRequestKey = (
  engine: Engine,
  action: 'create' | 'refresh',
  id: string,
  assetId: string,
) => JSON.stringify([engine.doc.ydoc.guid, action, id, assetId])

/** 取帧等待独立于操作条生命周期；切回同一素材不会重复提交。 */
export const useContinueRequests = create<{
  pending: ReadonlyMap<string, AbortController>
  begin(key: string): AbortController | null
  cancel(key: string): void
  end(key: string, controller: AbortController): void
}>((set, get) => ({
  pending: new Map(),
  begin(key) {
    if (get().pending.has(key)) return null
    const controller = new AbortController()
    set({ pending: new Map(get().pending).set(key, controller) })
    return controller
  },
  cancel(key) {
    const request = get().pending.get(key)
    if (!request || request.signal.aborted) return
    request.abort()
    set({ pending: new Map(get().pending) })
  },
  end(key, controller) {
    if (get().pending.get(key) !== controller) return
    const pending = new Map(get().pending)
    pending.delete(key)
    set({ pending })
  },
}))

/** 离开画布取消旧请求；同画布内选区切换允许后台完成。 */
export function beginContinueRequest(engine: Engine, key: string) {
  const owner = useCanvas.getState()
  if (owner.engine !== engine) return null
  const controller = useContinueRequests.getState().begin(key)
  if (!controller) return null
  const current = () =>
    useCanvas.getState().engine === engine && useCanvas.getState().canvasId === owner.canvasId
  const off = useCanvas.subscribe(() => {
    if (!current()) controller.abort()
  })
  if (!current()) controller.abort()
  return {
    signal: controller.signal,
    current,
    finish() {
      off()
      useContinueRequests.getState().end(key, controller)
    },
  }
}

/** 取消按钮退场后把键盘焦点还给原入口；用户已转向其他控件则不接管。 */
export function useContinueRequest(key: string) {
  const pending = useContinueRequests((state) => state.pending).get(key)
  const trigger = useRef<HTMLButtonElement>(null)
  const cancelledFrom = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    if (pending || !cancelledFrom.current) return
    const previous = cancelledFrom.current
    cancelledFrom.current = null
    if (
      (document.activeElement === previous ||
        (!previous.isConnected && document.activeElement === document.body)) &&
      !document.querySelector(
        '[role="dialog"]:not([data-closing]), [role="alertdialog"]:not([data-closing])',
      )
    )
      trigger.current?.focus()
  }, [pending])
  return {
    pending,
    trigger,
    cancel(button: HTMLButtonElement) {
      cancelledFrom.current = button
      useContinueRequests.getState().cancel(key)
    },
  }
}

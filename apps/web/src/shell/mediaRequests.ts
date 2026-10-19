import type { Engine } from '@plein/canvas-core'
import type { MediaDeriveRequest } from '@plein/protocol'
import { useLayoutEffect, useRef } from 'react'
import { create } from 'zustand'
import { applyDerivation, opLabel, type DerivedMedia, type MediaTarget } from '../canvas/media'
import { importLocation, watchImportView } from '../canvas/importView'
import { revealImports } from '../canvas/import'
import { useCanvas } from '../stores/canvas'

const targetKey = (engine: Engine, target: MediaTarget) =>
  JSON.stringify([engine.doc.ydoc.guid, target.elId, target.assetId])

/** 等待属于来源素材，操作条卸载或更换选区不会丢失防重入和取消入口。 */
const useMediaRequests = create<{ pending: ReadonlyMap<string, AbortController> }>(() => ({
  pending: new Map(),
}))

export function useMediaDeriver(engine: Engine, targets: MediaTarget[]) {
  const pending = useMediaRequests((s) => s.pending)
  const keys = targets.map((t) => targetKey(engine, t))
  const active = [...new Set(keys.flatMap((key) => pending.get(key) ?? []))]
  const busy = active.length > 0
  const trigger = useRef<HTMLButtonElement>(null)
  const cancelledFrom = useRef<HTMLButtonElement | null>(null)
  useLayoutEffect(() => {
    if (busy || !cancelledFrom.current) return
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
  }, [busy])

  const run = async (
    list: MediaTarget[],
    make: (t: MediaTarget) => MediaDeriveRequest,
    { skipped = 0 }: { skipped?: number } = {},
  ) => {
    const owner = useCanvas.getState()
    const requestKeys = list.map((t) => targetKey(engine, t))
    if (
      owner.engine !== engine ||
      !list.length ||
      requestKeys.some((k) => useMediaRequests.getState().pending.has(k))
    )
      return false
    const controller = new AbortController()
    const next = new Map(useMediaRequests.getState().pending)
    for (const key of requestKeys) next.set(key, controller)
    useMediaRequests.setState({ pending: next })
    const current = () =>
      useCanvas.getState().engine === engine && useCanvas.getState().canvasId === owner.canvasId
    const off = useCanvas.subscribe(() => {
      if (!current()) controller.abort()
    })
    const view = watchImportView(engine, controller.signal)
    const made: DerivedMedia[] = [],
      errors: string[] = []
    let op: MediaDeriveRequest['op'] | undefined
    try {
      for (const t of list) {
        if (controller.signal.aborted) break
        const name = engine.doc.get(t.elId)?.name?.trim() || '未命名素材'
        try {
          const input = make(t)
          op = input.op
          made.push(await applyDerivation(engine, input, t.elId, controller.signal))
        } catch (error) {
          if (!controller.signal.aborted) errors.push(`${name}：${(error as Error).message}`)
        }
      }
      if (!current()) return true
      const ids = made.flatMap((m) => m.created)
      const unchanged = view.unchanged()
      if (ids.length && unchanged) revealImports(engine, ids)
      const one = made[0]
      const message = controller.signal.aborted
        ? `已取消加工${made.length ? `，已完成 ${made.length} 个素材` : ''}`
        : list.length === 1
          ? one && op
            ? `已${opLabel(op)}，新素材放在右边：${one.assets.map((a) => a.name).join('、')}${one.note ? `。${one.note}` : ''}`
            : (errors[0] ?? null)
          : errors.length
            ? `${made.length} 个成功，${errors.length} 个失败：${errors[0]}`
            : op
              ? `已${opLabel(op)} ${made.length} 个素材，新素材放在右边`
              : null
      useCanvas
        .getState()
        .notify(
          message && skipped ? `${message}；${skipped} 个不适用素材未处理` : message,
          ids.length && !unchanged ? importLocation(engine, ids) : undefined,
        )
      return true
    } finally {
      view.dispose()
      off()
      const next = new Map(useMediaRequests.getState().pending)
      for (const key of requestKeys) if (next.get(key) === controller) next.delete(key)
      useMediaRequests.setState({ pending: next })
    }
  }
  return {
    busy,
    trigger,
    run,
    cancel(button: HTMLButtonElement) {
      cancelledFrom.current = button
      for (const controller of active) controller.abort()
    },
  }
}

import { type Engine, isEditableTarget } from '@plein/canvas-core'
import { type NoticeAction, useCanvas } from '../stores/canvas'
import { revealImports } from './import'

/** 用户后续操作优先；记录事件而非只比较最终值，避免切换后又切回来被当成未操作。 */
export function watchImportView(engine: Engine, signal?: AbortSignal) {
  let changed = false
  let disposed = false
  const focus = document.activeElement
  const tool = engine.state.tool
  const change = () => {
    changed = true
  }
  const off = [
    engine.selection.onChange(change),
    engine.camera.onChange(change),
    engine.onStateChange(() => {
      if (engine.state.tool !== tool) change()
    }),
  ]
  window.addEventListener('input', change, true)
  off.push(() => window.removeEventListener('input', change, true))
  window.addEventListener('pointerdown', change, true)
  off.push(() => window.removeEventListener('pointerdown', change, true))
  window.addEventListener('wheel', change, { capture: true, passive: true })
  off.push(() => window.removeEventListener('wheel', change, true))
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const stop of off) stop()
  }
  signal?.addEventListener('abort', dispose, { once: true })
  off.push(() => signal?.removeEventListener('abort', dispose))
  if (signal?.aborted) dispose()
  return {
    unchanged: () =>
      !disposed &&
      !changed &&
      (document.activeElement === focus || !isEditableTarget(document.activeElement)),
    dispose,
  }
}

export function importLocation(engine: Engine, ids: string[]): NoticeAction {
  return {
    label: '定位新素材',
    run() {
      if (useCanvas.getState().engine !== engine) return
      const existing = ids.filter((id) => engine.doc.has(id))
      if (existing.length) revealImports(engine, existing)
      else useCanvas.getState().notify('导入的素材已不在画布上')
    },
  }
}

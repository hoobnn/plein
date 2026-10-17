import { type Engine, isEditableTarget } from '@plein/canvas-core'
import { type NoticeAction, useCanvas } from '../stores/canvas'
import { revealImports } from './import'

/** 用户后续操作优先；记录事件而非只比较最终值，避免切换后又切回来被当成未操作。 */
export function watchImportView(engine: Engine) {
  let changed = false
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
  return {
    unchanged: () =>
      !changed && (document.activeElement === focus || !isEditableTarget(document.activeElement)),
    dispose: () => {
      for (const stop of off) stop()
    },
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

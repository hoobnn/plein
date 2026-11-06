import { minWidth } from '../../ui/layout'
import { useCanvas } from '../../stores/canvas'

/** 全宽任务面板先收起；等编辑器恢复侧栏和可见区域后，再定位原画布中的目标。 */
export function locateTaskTarget(id: string) {
  const { engine, canvasId, toggleTasks } = useCanvas.getState()
  if (!engine?.doc.has(id)) return
  engine.selection.set([id])
  if (window.matchMedia(minWidth('compact')).matches) {
    engine.zoomToFit([id])
    return
  }
  toggleTasks(false)
  requestAnimationFrame(() => {
    const current = useCanvas.getState()
    if (
      !current.tasks &&
      current.engine === engine &&
      current.canvasId === canvasId &&
      engine.doc.has(id)
    )
      engine.zoomToFit([id])
  })
}

import { lazy, Suspense } from 'react'
import { useCanvas } from '../../stores/canvas'
import { Presence } from '../../ui/Presence'

// three.js 只在打开构图时加载，画布页面不背这份体积
const StagePanel = lazy(() => import('./StagePanel').then((m) => ({ default: m.StagePanel })))

/** 3D 构图编辑器：全屏浮层，关闭时销毁 WebGL 上下文 */
export function StageEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.stage)
  const close = () => useCanvas.getState().openStage(null)
  return (
    <Presence>
      {engine && id && engine.doc.get(id) && (
        <Suspense fallback={null}>
          <StagePanel engine={engine} id={id} onClose={close} />
        </Suspense>
      )}
    </Presence>
  )
}

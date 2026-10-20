import { STAGE_TYPE } from '@plein/nodes'
import { lazy, Suspense, useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useCanvas } from '../../stores/canvas'
import { Presence } from '../../ui/Presence'

// three.js 只在打开构图时加载，画布页面不背这份体积
const StagePanel = lazy(() => import('./StagePanel').then((m) => ({ default: m.StagePanel })))

/** 3D 构图编辑器：全屏浮层，关闭时销毁 WebGL 上下文 */
export function StageEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.stage)
  const target = useSyncExternalStore(
    useCallback((notify) => engine?.doc.subscribe(notify) ?? (() => {}), [engine]),
    useCallback(() => {
      const node = engine && id ? engine.doc.elementMaps.get(id) : undefined
      return node?.get('nodeType') === STAGE_TYPE ? node : undefined
    }, [engine, id]),
  )
  const identity = useRef({ target, revision: 0 })
  if (identity.current.target !== target) {
    identity.current = { target, revision: identity.current.revision + 1 }
  }
  useEffect(() => {
    const state = useCanvas.getState()
    if (engine && id && !target && state.engine === engine && state.stage === id) {
      state.openStage(null)
      state.notify('构图节点已删除或类型已变更，编辑器已关闭')
    }
  }, [engine, id, target])
  const close = () => useCanvas.getState().openStage(null)
  return (
    <Presence>
      {engine && id && target && (
        <Suspense fallback={null}>
          <StagePanel
            key={`${engine.doc.ydoc.guid}:${id}:${identity.current.revision}`}
            engine={engine}
            id={id}
            onClose={close}
          />
        </Suspense>
      )}
    </Presence>
  )
}

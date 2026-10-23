import { MOTION_TYPE } from '@plein/nodes'
import { lazy, Suspense, useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useCanvas } from '../../stores/canvas'
import { Presence } from '../../ui/Presence'

// SDK 与编辑器只随动态合成面板加载。
const MotionPanel = lazy(() => import('./MotionPanel').then((m) => ({ default: m.MotionPanel })))

export function MotionEditor() {
  const engine = useCanvas((s) => s.engine)
  const id = useCanvas((s) => s.motion)
  const target = useSyncExternalStore(
    useCallback((notify) => engine?.doc.subscribe(notify) ?? (() => {}), [engine]),
    useCallback(() => {
      const node = engine && id ? engine.doc.elementMaps.get(id) : undefined
      return node?.get('nodeType') === MOTION_TYPE ? node : undefined
    }, [engine, id]),
  )
  const identity = useRef({ target, revision: 0 })
  if (identity.current.target !== target)
    identity.current = { target, revision: identity.current.revision + 1 }
  useEffect(() => {
    const state = useCanvas.getState()
    if (engine && id && !target && state.engine === engine && state.motion === id) {
      state.openMotion(null)
      state.notify('动态合成节点已删除或类型已变更，编辑器已关闭')
    }
  }, [engine, id, target])
  return (
    <Presence>
      {engine && id && target && (
        <Suspense fallback={null}>
          <MotionPanel
            key={`${engine.doc.ydoc.guid}:${id}:${identity.current.revision}`}
            engine={engine}
            id={id}
            onClose={() => useCanvas.getState().openMotion(null)}
          />
        </Suspense>
      )}
    </Presence>
  )
}

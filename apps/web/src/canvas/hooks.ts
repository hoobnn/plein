import type { Engine } from '@plein/canvas-core'
import type { PleinDoc } from '@plein/doc'
import { useRef, useSyncExternalStore } from 'react'

/** 订阅一组事件源，任一触发就递增版本号，驱动组件重渲染 */
function useVersion(subscribe: (bump: () => void) => () => void) {
  const ref = useRef(0)
  return useSyncExternalStore(
    (notify) =>
      subscribe(() => {
        ref.current++
        notify()
      }),
    () => ref.current,
  )
}

/** 引擎任一变化（相机、选中、文档内容）时递增：浮在元素旁的面板靠它重渲染和跟随定位 */
export function useEngineVersion(engine: Engine) {
  return useVersion((bump) => {
    const offs = [
      engine.onStateChange(bump),
      engine.onViewChange(bump),
      engine.selection.onChange(bump),
    ]
    return () => {
      for (const off of offs) off()
    }
  })
}

/** 选中变化时递增 */
export function useSelectionVersion(engine: Engine) {
  return useVersion((bump) => engine.selection.onChange(bump))
}

/** 文档内容变化时递增（含协作者的修改）：列表、表格类面板靠它刷新 */
export function useDocVersion(doc: PleinDoc) {
  return useVersion((bump) => doc.subscribe(bump))
}

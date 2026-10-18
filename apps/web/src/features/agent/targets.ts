import type { PleinDoc } from '@plein/doc'
import { useSyncExternalStore } from 'react'
import { useCanvas } from '../../stores/canvas'

export const existingTargets = (doc: Pick<PleinDoc, 'get'> | undefined, ids: readonly string[]) =>
  [...new Set(ids)].filter((id) => doc?.get(id))

/** 仅相关元素变化时检查存在性；几何和正文变化不触发卡片重绘。 */
export function useAgentTargets(ids: readonly string[]) {
  const engine = useCanvas((s) => s.engine)
  const signature = useSyncExternalStore(
    (notify) =>
      engine && ids.length
        ? engine.doc.subscribe((change) => {
            if (ids.some((id) => change.elements.has(id))) notify()
          })
        : () => {},
    () => JSON.stringify(existingTargets(engine?.doc, ids)),
  )
  return { engine, ids: JSON.parse(signature) as string[] }
}

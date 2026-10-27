import type { Engine } from '@plein/canvas-core'
import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { placeLibraryItem, type PlaceInput } from './canvas'
import { useLibrary } from './store'
import { useCompositionSourcePicker } from '../media-library/CompositionSourcePicker'

const keyOf = (input: PlaceInput) => input.libraryId ?? `${input.kind.id}:${input.name}`

/** 放置请求属于当前入口与引擎；迟到的读取不得修改旧文档或操作新的面板。 */
export function useLibraryPlacement(engine: Engine | null, scope: unknown = null) {
  const sourcePicker = useCompositionSourcePicker(scope, !!engine && !engine.doc.readOnly, engine)
  // 待办集合跟着会话走：会话结束时请求仍要清掉自己那条，不能把条目永久卡在「正在放入」。
  const lifetime = useRef<{ active: boolean; pending: Set<string> } | null>(null)
  const [placing, setPlacing] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const session = { active: true, pending: new Set<string>() }
    lifetime.current = session
    setPlacing([])
    setError(null)
    return () => {
      session.active = false
    }
  }, [engine, scope])

  const place = async (input: PlaceInput) => {
    const session = lifetime.current
    if (!session) return null
    const current = () => session.active && useCanvas.getState().engine === engine
    const key = keyOf(input)
    if (!engine || !current() || session.pending.has(key)) return null
    session.pending.add(key)
    setError(null)
    setPlacing([...session.pending])
    try {
      const result = await placeLibraryItem(
        engine,
        useCatalog.getState().catalog,
        input,
        current,
        sourcePicker.resolve,
      )
      if (!current()) return null
      if (input.libraryId && result.id) useLibrary.getState().markUsed(input.libraryId)
      if (result.notice) useCanvas.getState().notify(result.notice)
      return result
    } catch (error) {
      if (current() && (error as Error).name !== 'AbortError') {
        const message = `放入资产失败（${input.name}）：${(error as Error).message}`
        setError(message)
        useCanvas.getState().notify(message)
      }
      return null
    } finally {
      session.pending.delete(key)
      // 只有还活着的会话能刷新「正在放入」；换会话后由新会话自己管这份状态。
      if (lifetime.current === session) setPlacing([...session.pending])
    }
  }
  return {
    place,
    sourcePicker: sourcePicker.picker,
    error,
    placing: placing.length > 0,
    isPlacing: (input: PlaceInput) => placing.includes(keyOf(input)),
  }
}

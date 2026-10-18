import type { Engine } from '@plein/canvas-core'
import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { placeLibraryItem, type PlaceInput } from './canvas'
import { useLibrary } from './store'

const keyOf = (input: PlaceInput) => input.libraryId ?? `${input.kind.id}:${input.name}`

/** 放置请求属于当前入口与引擎；迟到的读取不得修改旧文档或操作新的面板。 */
export function useLibraryPlacement(engine: Engine | null, scope: unknown = null) {
  const lifetime = useRef<{ active: boolean } | null>(null)
  const pending = useRef(new Set<string>())
  const [placing, setPlacing] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const session = { active: true }
    lifetime.current = session
    pending.current = new Set()
    setPlacing([])
    setError(null)
    return () => {
      session.active = false
    }
  }, [engine, scope])

  const place = async (input: PlaceInput) => {
    const session = lifetime.current
    const current = () => !!session?.active && useCanvas.getState().engine === engine
    const key = keyOf(input)
    if (!engine || !current() || pending.current.has(key)) return null
    pending.current.add(key)
    setError(null)
    setPlacing([...pending.current])
    try {
      const result = await placeLibraryItem(engine, useCatalog.getState().catalog, input, current)
      if (!current()) return null
      if (input.libraryId && result.id) useLibrary.getState().markUsed(input.libraryId)
      if (result.notice) useCanvas.getState().notify(result.notice)
      return result
    } catch (error) {
      if (current()) {
        const message = `放入资产失败（${input.name}）：${(error as Error).message}`
        setError(message)
        useCanvas.getState().notify(message)
      }
      return null
    } finally {
      if (current()) {
        pending.current.delete(key)
        setPlacing([...pending.current])
      }
    }
  }
  return {
    place,
    error,
    placing: placing.length > 0,
    isPlacing: (input: PlaceInput) => placing.includes(keyOf(input)),
  }
}

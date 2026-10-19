import type { Asset } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'

/** 资产元信息只读、写入即不可变，整个会话缓存一份；读失败的不缓存，下次再问 */
const cache = new Map<string, Promise<Asset>>()
const loaded = new Map<string, Asset>()

export function loadAssetMeta(id: string): Promise<Asset> {
  let p = cache.get(id)
  if (!p) {
    p = api.assetMeta(id).then(
      (a) => {
        loaded.set(id, a)
        return a
      },
      (err) => {
        cache.delete(id)
        throw err
      },
    )
    cache.set(id, p)
  }
  return p
}

/** 已经取回来的元信息；还没取过或取失败时为 undefined */
export const assetMetaNow = (id: string): Asset | undefined => loaded.get(id)

/** 列表里展示尺寸、时长用；读不到时为 null */
export function useAssetMeta(id: string | undefined): Asset | null {
  const [meta, setMeta] = useState<Asset | null>(() => (id && loaded.get(id)) || null)
  useEffect(() => {
    setMeta((id && loaded.get(id)) || null)
    if (!id) return
    let live = true
    loadAssetMeta(id).then(
      (m) => live && setMeta(m),
      () => {},
    )
    return () => {
      live = false
    }
  }, [id])
  return meta
}

/** 一组资产的元信息；reload 只重试尚未成功读取的项，保留不可变资产缓存。 */
export function useAssetMetas(ids: string[], reload = 0) {
  const key = JSON.stringify([...new Set(ids.filter(Boolean))])
  const [state, setState] = useState<{ key: string; errors: Record<string, string> }>({
    key: '',
    errors: {},
  })
  useEffect(() => {
    const current = JSON.parse(key) as string[]
    let live = true
    setState({ key, errors: {} })
    for (const id of current) {
      if (loaded.has(id)) continue
      loadAssetMeta(id).then(
        () => {
          if (live) setState((s) => ({ ...s }))
        },
        (error: unknown) => {
          if (live)
            setState((s) => ({
              key,
              errors: {
                ...s.errors,
                [id]: error instanceof Error ? error.message : '素材信息读取失败',
              },
            }))
        },
      )
    }
    return () => {
      live = false
    }
  }, [key, reload])
  const errors = Object.entries(state.key === key ? state.errors : {})
    .filter(([id]) => !loaded.has(id))
    .map(([id, message]) => ({ id, message }))
  return {
    get: (id: string | undefined) => (id ? loaded.get(id) : undefined),
    errors,
    loading: ids.some((id) => id && !loaded.has(id) && !errors.some((error) => error.id === id)),
  }
}

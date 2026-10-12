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

/** 一组资产的元信息，按 id 取；还没到或读不到时为 undefined */
export function useAssetMetas(ids: string[]): (id: string | undefined) => Asset | undefined {
  const [, setV] = useState(0)
  const key = ids.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: key 即 ids
  useEffect(() => {
    let live = true
    for (const id of ids) {
      if (!id || loaded.has(id)) continue
      loadAssetMeta(id).then(
        () => live && setV((x) => x + 1),
        () => {},
      )
    }
    return () => {
      live = false
    }
  }, [key])
  return (id) => (id ? loaded.get(id) : undefined)
}

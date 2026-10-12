import type { Asset } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'

/** 资产元信息只读、写入即不可变，整个会话缓存一份 */
const cache = new Map<string, Promise<Asset | null>>()

function load(id: string) {
  let p = cache.get(id)
  if (!p) {
    p = api.assetMeta(id).catch(() => null)
    cache.set(id, p)
  }
  return p
}

/** 列表里展示尺寸、时长用；读不到时为 null */
export function useAssetMeta(id: string | undefined): Asset | null {
  const [meta, setMeta] = useState<Asset | null>(null)
  useEffect(() => {
    setMeta(null)
    if (!id) return
    let live = true
    void load(id).then((m) => live && setMeta(m))
    return () => {
      live = false
    }
  }, [id])
  return meta
}

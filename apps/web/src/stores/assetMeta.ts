import type { Asset } from '@plein/protocol'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'

export const ASSET_META_CACHE_LIMIT = 512

/** 请求中去重；不可变元信息按最近使用淘汰，活跃组件自持结果。 */
export class AssetMetaCache {
  private pending = new Map<string, Promise<Asset>>()
  private loaded = new Map<string, Asset>()

  constructor(private readonly limit = ASSET_META_CACHE_LIMIT) {}

  get stats() {
    return { ready: this.loaded.size, pending: this.pending.size, limit: this.limit }
  }

  get(id: string) {
    const asset = this.loaded.get(id)
    if (asset) {
      this.loaded.delete(id)
      this.loaded.set(id, asset)
    }
    return asset
  }

  load(id: string): Promise<Asset> {
    const asset = this.get(id)
    if (asset) return Promise.resolve(asset)
    let request = this.pending.get(id)
    if (!request) {
      request = api.assetMeta(id).then(
        (asset) => {
          this.pending.delete(id)
          this.loaded.set(id, asset)
          while (this.loaded.size > this.limit) this.loaded.delete(this.loaded.keys().next().value!)
          return asset
        },
        (error) => {
          this.pending.delete(id)
          throw error
        },
      )
      this.pending.set(id, request)
    }
    return request
  }
}

export const assetMetaCache = new AssetMetaCache()
export const loadAssetMeta = (id: string): Promise<Asset> => assetMetaCache.load(id)

/** 最近缓存的元信息；未加载、读取失败或已淘汰时为 undefined */
export const assetMetaNow = (id: string): Asset | undefined => assetMetaCache.get(id)

/** 列表里展示尺寸、时长用；读不到时为 null */
export function useAssetMeta(id: string | undefined): Asset | null {
  const [meta, setMeta] = useState<Asset | null>(() => (id && assetMetaNow(id)) || null)
  useEffect(() => {
    setMeta((id && assetMetaNow(id)) || null)
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
  const requested = new Set(ids.filter(Boolean))
  const key = JSON.stringify([...requested])
  const retained = useRef({ key: '', assets: new Map<string, Asset>() })
  const [state, setState] = useState<{
    key: string
    revision: number
    errors: Record<string, string>
  }>({
    key: '',
    revision: 0,
    errors: {},
  })
  useEffect(() => {
    const current = JSON.parse(key) as string[]
    let live = true
    const assets = new Map<string, Asset>()
    for (const id of current) {
      const asset = retained.current.assets.get(id) ?? assetMetaNow(id)
      if (asset) assets.set(id, asset)
    }
    retained.current = { key, assets }
    setState({ key, revision: 0, errors: {} })
    for (const id of current) {
      if (assets.has(id)) continue
      loadAssetMeta(id).then(
        (asset) => {
          if (live) {
            assets.set(id, asset)
            setState((s) => ({ ...s, revision: s.revision + 1 }))
          }
        },
        (error: unknown) => {
          if (live)
            setState((s) => ({
              ...s,
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
  const assets = state.key === key ? retained.current.assets : new Map<string, Asset>()
  const get = (id: string | undefined) => {
    if (!id || !requested.has(id)) return undefined
    // 异步操作可能持有重试前的 getter；同一列表读最新快照，外部成功重试也补入本地保留。
    const current = retained.current.key === key ? retained.current.assets : assets
    const asset = current.get(id) ?? assetMetaNow(id)
    if (asset) current.set(id, asset)
    return asset
  }
  const errors = Object.entries(state.key === key ? state.errors : {})
    .filter(([id]) => !get(id))
    .map(([id, message]) => ({ id, message }))
  return {
    get,
    errors,
    loading: ids.some((id) => id && !get(id) && !errors.some((error) => error.id === id)),
  }
}

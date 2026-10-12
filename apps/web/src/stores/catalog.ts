import type { Catalog } from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../api/client'

interface CatalogStore {
  catalog: Catalog | null
  error: string | null
  load(): Promise<void>
}

/** 已安装插件提供的节点、平台、模板；设置变更后重新加载 */
export const useCatalog = create<CatalogStore>((set) => ({
  catalog: null,
  error: null,
  async load() {
    try {
      set({ catalog: await api.catalog(), error: null })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },
}))

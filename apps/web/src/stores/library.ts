import type {
  CreateLibraryItem,
  LibraryItem,
  LibraryKind,
  UpdateLibraryItem,
} from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../api/client'

interface LibraryStore {
  items: LibraryItem[]
  loaded: boolean
  /** 资产库面板：打开哪一类；null 为关闭 */
  open: LibraryKind | null
  /** 当前画布所属项目，「本项目」筛选与新建条目的默认归属 */
  projectId: string | null
  setProject(id: string | null): void
  show(kind: LibraryKind | null): void
  load(): Promise<void>
  create(body: CreateLibraryItem): Promise<LibraryItem>
  update(id: string, body: UpdateLibraryItem): Promise<LibraryItem>
  remove(id: string): Promise<void>
  /** 记一次用到画布上（失败不影响插入） */
  markUsed(id: string): void
}

const replace = (items: LibraryItem[], item: LibraryItem) =>
  items.map((i) => (i.id === item.id ? item : i))

/** 资产库条目（角色、场景、道具、风格、特效），全部类别一次取回，数量是个人量级 */
export const useLibrary = create<LibraryStore>((set, get) => ({
  items: [],
  loaded: false,
  open: null,
  projectId: null,
  setProject(projectId) {
    set({ projectId })
  },
  show(open) {
    set({ open })
    if (open && !get().loaded) void get().load()
  },
  async load() {
    try {
      set({ items: await api.library(), loaded: true })
    } catch {
      // 演示模式没有服务端，保持为空
      set({ loaded: true })
    }
  },
  async create(body) {
    const item = await api.createLibraryItem(body)
    set({ items: [item, ...get().items] })
    return item
  },
  async update(id, body) {
    const item = await api.updateLibraryItem(id, body)
    set({ items: replace(get().items, item) })
    return item
  },
  async remove(id) {
    await api.deleteLibraryItem(id)
    set({ items: get().items.filter((i) => i.id !== id) })
  },
  markUsed(id) {
    const now = Date.now()
    set({ items: get().items.map((i) => (i.id === id ? { ...i, usedAt: now } : i)) })
    api.markLibraryUsed(id).catch(() => {})
  },
}))

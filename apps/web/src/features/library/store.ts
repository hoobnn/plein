import type {
  CreateLibraryItem,
  LibraryItem,
  LibraryKind,
  UpdateLibraryItem,
} from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'
import { reconcileList } from '../../api/listSnapshot'

/** 从画布带进资产库的内容：打开面板时直接进入预填好的新建表单 */
export interface LibrarySeed {
  name?: string
  /** 图片资产 id，按画布上的顺序 */
  images: string[]
  /** 视频资产 id（只有特效收参考视频） */
  videos: string[]
}

interface LibraryStore {
  items: LibraryItem[]
  loaded: boolean
  loading: boolean
  error: string | null
  /** 资产库面板：打开哪一类；null 为关闭 */
  open: LibraryKind | null
  /** 打开时要预填的新建内容；面板接手后清掉 */
  seed: LibrarySeed | null
  /** 打开时直接进入编辑的条目 id（画布上角色卡的「编辑档案」）；面板接手后清掉 */
  focus: string | null
  /** 进入编辑时先打开哪一页（如「时期」） */
  tab: 'basics' | 'periods' | 'expressions' | null
  /** 当前画布所属项目，「本项目」筛选与新建条目的默认归属 */
  projectId: string | null
  setProject(id: string | null): void
  show(kind: LibraryKind | null, seed?: LibrarySeed): void
  /** 打开资产库并直接编辑一条，可指定先看哪一页 */
  edit(item: LibraryItem, tab?: LibraryStore['tab']): void
  takeSeed(): LibrarySeed | null
  takeFocus(): string | null
  takeTab(): LibraryStore['tab']
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
export const useLibrary = create<LibraryStore>((set, get) => {
  let loading: Promise<void> | undefined
  let removed: Set<string> | undefined
  return {
    items: [],
    loaded: false,
    loading: false,
    error: null,
    open: null,
    seed: null,
    focus: null,
    tab: null,
    projectId: null,
    setProject(projectId) {
      set({ projectId })
    },
    show(open, seed) {
      set({ open, seed: open ? (seed ?? null) : null })
      if (open) void get().load()
    },
    edit(item, tab) {
      set({ open: item.kind, seed: null, focus: item.id, tab: tab ?? null })
    },
    takeFocus() {
      const { focus } = get()
      if (focus) set({ focus: null })
      return focus
    },
    takeTab() {
      const { tab } = get()
      if (tab) set({ tab: null })
      return tab
    },
    takeSeed() {
      const { seed } = get()
      if (seed) set({ seed: null })
      return seed
    },
    load() {
      if (loading) return loading
      const before = get().items
      removed = new Set()
      set({ error: null, loading: true })
      loading = api
        .library()
        .then(
          (items) =>
            set({ items: reconcileList(items, before, get().items, removed), loaded: true }),
          (err: unknown) => set({ error: (err as Error).message }),
        )
        .finally(() => {
          loading = undefined
          removed = undefined
          set({ loading: false })
        })
      return loading
    },
    async create(body) {
      const item = await api.createLibraryItem(body)
      set({ items: [item, ...get().items.filter((i) => i.id !== item.id)] })
      return item
    },
    async update(id, body) {
      const item = await api.updateLibraryItem(id, body)
      set({ items: replace(get().items, item) })
      return item
    },
    async remove(id) {
      await api.deleteLibraryItem(id)
      removed?.add(id)
      set({ items: get().items.filter((i) => i.id !== id) })
    },
    markUsed(id) {
      const now = Date.now()
      set({ items: get().items.map((i) => (i.id === id ? { ...i, usedAt: now } : i)) })
      api.markLibraryUsed(id).catch(() => {})
    },
  }
})

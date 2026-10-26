import type {
  ArchiveCharacterImage,
  CreateLibraryItem,
  LibraryItem,
  LibraryKind,
  UpdateLibraryItem,
  SaveLibraryCard,
  SaveLibraryCardResult,
} from '@plein/protocol'
import { create } from 'zustand'
import { api } from '../../api/client'
import { reconcileList } from '../../api/listSnapshot'

/** 资产库面板的页签：各类资产卡，加上不放到画布上的「我的音色」 */
export type LibraryTab = LibraryKind | 'voice'

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
  /** 资产库面板：打开哪一类（voice 是「我的音色」页）；null 为关闭 */
  open: LibraryTab | null
  /** 打开时要预填的新建内容；面板接手后清掉 */
  seed: LibrarySeed | null
  /** 打开时直接进入编辑的条目 id（画布上角色卡的「编辑档案」）；面板接手后清掉 */
  focus: string | null
  /** 进入编辑时先打开哪一页（如「时期」） */
  tab: 'basics' | 'periods' | 'expressions' | null
  /** 当前画布所属项目，「本项目」筛选与新建条目的默认归属 */
  projectId: string | null
  setProject(id: string | null): void
  show(kind: LibraryTab | null, seed?: LibrarySeed): void
  /** 打开资产库并直接编辑一条，可指定先看哪一页 */
  edit(item: LibraryItem, tab?: LibraryStore['tab']): void
  takeSeed(): LibrarySeed | null
  takeFocus(): string | null
  takeTab(): LibraryStore['tab']
  load(): Promise<void>
  create(body: CreateLibraryItem): Promise<LibraryItem>
  saveCard(body: SaveLibraryCard): Promise<SaveLibraryCardResult>
  update(id: string, body: UpdateLibraryItem): Promise<LibraryItem>
  archiveCharacterImage(id: string, body: ArchiveCharacterImage): Promise<LibraryItem>
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
  const updates = new Map<string, Promise<unknown>>()
  const archives = new Map<string, Promise<SaveLibraryCardResult>>()
  const uses = new Map<string, { at: number }>()
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
      // 读取期间提交完成也不能让旧列表覆盖这次真实使用。
      const usedBefore = new Map(uses)
      removed = new Set()
      set({ error: null, loading: true })
      loading = api
        .library()
        .then(
          (items) =>
            set({
              items: reconcileList(items, before, get().items, removed).map((item) => {
                const usedAt = (uses.get(item.id) ?? usedBefore.get(item.id))?.at
                return usedAt !== undefined && (item.usedAt === null || usedAt > item.usedAt)
                  ? { ...item, usedAt }
                  : item
              }),
              loaded: true,
            }),
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
    saveCard(body) {
      const key = `${body.canvasId}:${body.nodeId}:${body.expectedLibraryId ?? ''}`
      const existing = archives.get(key)
      if (existing) return existing
      const submitted = structuredClone(body)
      const write = async () => {
        const result = await api.saveLibraryCard(submitted)
        const usedAt = get().items.find((item) => item.id === result.item.id)?.usedAt
        const item =
          usedAt != null && (result.item.usedAt === null || usedAt > result.item.usedAt)
            ? { ...result.item, usedAt }
            : result.item
        if (get().items.some((entry) => entry.id === item.id))
          set({ items: replace(get().items, item) })
        else if (item.id !== submitted.expectedLibraryId) set({ items: [item, ...get().items] })
        return { ...result, item }
      }
      const id = body.expectedLibraryId
      const operation = (id ? (updates.get(id) ?? Promise.resolve()) : Promise.resolve()).then(
        write,
        write,
      )
      archives.set(key, operation)
      if (id) updates.set(id, operation)
      const clear = () => {
        if (archives.get(key) === operation) archives.delete(key)
        if (id && updates.get(id) === operation) updates.delete(id)
      }
      void operation.then(clear, clear)
      return operation
    },
    update(id, body) {
      const submitted = structuredClone(body)
      const write = async () => {
        const item = await api.updateLibraryItem(id, submitted)
        const usedAt = get().items.find((entry) => entry.id === id)?.usedAt
        const saved =
          usedAt != null && (item.usedAt === null || usedAt > item.usedAt)
            ? { ...item, usedAt }
            : item
        set({ items: replace(get().items, saved) })
        return saved
      }
      // 同一条目按用户提交顺序写入；失败不阻塞后续编辑，其他条目仍可并行。
      const operation = (updates.get(id) ?? Promise.resolve()).then(write, write)
      updates.set(id, operation)
      const clear = () => {
        if (updates.get(id) === operation) updates.delete(id)
      }
      void operation.then(clear, clear)
      return operation
    },
    archiveCharacterImage(id, body) {
      const submitted = structuredClone(body)
      const write = async () => {
        const item = await api.archiveCharacterImage(id, submitted)
        const usedAt = get().items.find((entry) => entry.id === id)?.usedAt
        const saved =
          usedAt != null && (item.usedAt === null || usedAt > item.usedAt)
            ? { ...item, usedAt }
            : item
        // 归档响应只替换原 ID；不插入已删除条目，也不接管其他画布或角色。
        set({ items: replace(get().items, saved) })
        return saved
      }
      const operation = (updates.get(id) ?? Promise.resolve()).then(write, write)
      updates.set(id, operation)
      const clear = () => {
        if (updates.get(id) === operation) updates.delete(id)
      }
      void operation.then(clear, clear)
      return operation
    },
    async remove(id) {
      await api.deleteLibraryItem(id)
      uses.delete(id)
      removed?.add(id)
      set({ items: get().items.filter((i) => i.id !== id) })
    },
    markUsed(id) {
      const now = Date.now()
      const use = { at: now }
      uses.set(id, use)
      set({ items: get().items.map((i) => (i.id === id ? { ...i, usedAt: now } : i)) })
      void api
        .markLibraryUsed(id)
        .catch(() => {})
        .finally(() => {
          if (uses.get(id) === use) uses.delete(id)
        })
    },
  }
})

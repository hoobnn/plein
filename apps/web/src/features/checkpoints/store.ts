import { create } from 'zustand'

interface CheckpointStore {
  open: { projectId: string; canvasId?: string } | null
  show(context: { projectId: string; canvasId?: string }): void
  close(): void
  removing: ReadonlySet<string>
  removal: { id: string } | null
  beginRemove(id: string): boolean
  finishRemove(id: string, deleted: boolean): void
}

export const useCheckpoints = create<CheckpointStore>((set, get) => ({
  open: null,
  removing: new Set(),
  removal: null,
  beginRemove: (id) => {
    const { removing } = get()
    if (removing.has(id)) return false
    set({ removing: new Set([...removing, id]) })
    return true
  },
  finishRemove: (id, deleted) => {
    const { removing } = get()
    const next = new Set(removing)
    next.delete(id)
    // 每次成功生成独立事件，当前窗口和重开后的窗口共享完成结果。
    set({ removing: next, ...(deleted ? { removal: { id } } : {}) })
  },
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}))

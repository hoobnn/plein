import { create } from 'zustand'

export const runRequestKey = (canvasId: string | null, nodeId: string) =>
  JSON.stringify([canvasId, nodeId])

/** 等待受理应答期间也保护单节点提交，状态独立于生成器与任务面板生命周期。 */
export const useRunRequests = create<{
  pending: ReadonlySet<string>
  begin(key: string): boolean
  end(key: string): void
}>((set, get) => ({
  pending: new Set(),
  begin(key) {
    if (get().pending.has(key)) return false
    set({ pending: new Set(get().pending).add(key) })
    return true
  },
  end(key) {
    const pending = new Set(get().pending)
    if (pending.delete(key)) set({ pending })
  },
}))

import { create } from 'zustand'

interface RecoveryRequests {
  /** JSON 编码的 [canvasId, jobId]；请求完成前跨面板、跨挂载共享。 */
  pending: ReadonlySet<string>
  begin(key: string): boolean
  end(key: string): void
}

export const useRecoveryRequests = create<RecoveryRequests>((set, get) => ({
  pending: new Set(),
  begin(key) {
    if (get().pending.has(key)) return false
    set({ pending: new Set(get().pending).add(key) })
    return true
  },
  end(key) {
    if (!get().pending.has(key)) return
    const pending = new Set(get().pending)
    pending.delete(key)
    set({ pending })
  },
}))

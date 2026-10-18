import { create } from 'zustand'

export const cancelRequestKey = (canvasId: string | null, nodeId: string, runId?: string) =>
  JSON.stringify([canvasId, nodeId, runId ?? null])

export const useCancelRequests = create<{
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
    if (!get().pending.has(key)) return
    const pending = new Set(get().pending)
    pending.delete(key)
    set({ pending })
  },
}))

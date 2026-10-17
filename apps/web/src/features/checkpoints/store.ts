import { create } from 'zustand'

interface CheckpointStore {
  open: { projectId: string; canvasId?: string } | null
  show(context: { projectId: string; canvasId?: string }): void
  close(): void
}

export const useCheckpoints = create<CheckpointStore>((set) => ({
  open: null,
  show: (open) => set({ open }),
  close: () => set({ open: null }),
}))

import type { MediaSource } from '@plein/protocol'
import { create } from 'zustand'

interface MediaLibraryStore {
  open: { projectId?: string } | null
  target: (Pick<MediaSource, 'canvasId' | 'nodeId'> & { assetId: string }) | null
  show(context?: { projectId?: string }): void
  close(): void
  locate(target: MediaLibraryStore['target']): void
}

export const useMediaLibrary = create<MediaLibraryStore>((set) => ({
  open: null,
  target: null,
  show: (context = {}) => set({ open: context }),
  close: () => set({ open: null }),
  locate: (target) => set({ target, open: null }),
}))

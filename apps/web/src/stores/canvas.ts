import type { Engine, EngineState } from '@plein/canvas-core'
import { create } from 'zustand'

export type SyncStatus = 'local' | 'connecting' | 'connected' | 'disconnected'

interface CanvasStore extends EngineState {
  engine: Engine | null
  sync: SyncStatus
  /** 正在导入的文件：已完成 / 总数 */
  importing: { done: number; total: number } | null
  notice: string | null
  /** 挂载引擎并把它的运行时状态镜像到 store（只在状态变化时更新，不跟随每帧） */
  attach(engine: Engine): () => void
  setSync(sync: SyncStatus): void
  setImporting(importing: { done: number; total: number } | null): void
  notify(notice: string | null): void
}

const initial: EngineState = {
  tool: 'select',
  zoom: 1,
  selection: 0,
  canUndo: false,
  canRedo: false,
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined

export const useCanvas = create<CanvasStore>((set) => ({
  ...initial,
  engine: null,
  sync: 'local',
  importing: null,
  notice: null,
  attach(engine) {
    const sync = () => set(engine.state)
    const off = engine.onStateChange(sync)
    set({ engine, ...engine.state })
    return () => {
      off()
      set({ engine: null, ...initial })
    }
  },
  setSync: (sync) => set({ sync }),
  setImporting: (importing) => set({ importing }),
  notify(notice) {
    clearTimeout(noticeTimer)
    set({ notice })
    if (notice) noticeTimer = setTimeout(() => set({ notice: null }), 4000)
  },
}))

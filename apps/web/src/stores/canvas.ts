import type { Engine, EngineState } from '@plein/canvas-core'
import { create } from 'zustand'

interface CanvasStore extends EngineState {
  engine: Engine | null
  /** 挂载引擎并把它的运行时状态镜像到 store（只在状态变化时更新，不跟随每帧） */
  attach(engine: Engine): () => void
}

const initial: EngineState = {
  tool: 'select',
  zoom: 1,
  selection: 0,
  canUndo: false,
  canRedo: false,
}

export const useCanvas = create<CanvasStore>((set) => ({
  ...initial,
  engine: null,
  attach(engine) {
    const sync = () => set(engine.state)
    const off = engine.onStateChange(sync)
    set({ engine, ...engine.state })
    return () => {
      off()
      set({ engine: null, ...initial })
    }
  },
}))

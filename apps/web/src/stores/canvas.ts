import type { CanvasMenuEvent, Engine, EngineState } from '@plein/canvas-core'
import { create } from 'zustand'

export type SyncStatus = 'local' | 'connecting' | 'connected' | 'disconnected'

interface CanvasStore extends EngineState {
  engine: Engine | null
  sync: SyncStatus
  /** 正在导入的文件：已完成 / 总数 */
  importing: { done: number; total: number } | null
  notice: string | null
  /** 远端画布 id；本地演示时为空（不能运行节点） */
  canvasId: string | null
  /** 当前弹出的画布菜单：节点选择器或右键菜单 */
  menu: CanvasMenuEvent | null
  /** 打开表格编辑器的分镜节点 */
  storyboard: string | null
  /** 挂载引擎并把它的运行时状态镜像到 store（只在状态变化时更新，不跟随每帧） */
  attach(engine: Engine): () => void
  setSync(sync: SyncStatus): void
  setImporting(importing: { done: number; total: number } | null): void
  notify(notice: string | null): void
  setCanvasId(id: string | null): void
  setMenu(menu: CanvasMenuEvent | null): void
  openStoryboard(id: string | null): void
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
  canvasId: null,
  menu: null,
  storyboard: null,
  attach(engine) {
    const sync = () => set(engine.state)
    const off = engine.onStateChange(sync)
    const offMenu = engine.onMenu((menu) => set({ menu }))
    set({ engine, ...engine.state })
    return () => {
      off()
      offMenu()
      set({ engine: null, menu: null, storyboard: null, ...initial })
    }
  },
  setCanvasId: (canvasId) => set({ canvasId }),
  setMenu: (menu) => set({ menu }),
  openStoryboard: (storyboard) => set({ storyboard }),
  setSync: (sync) => set({ sync }),
  setImporting: (importing) => set({ importing }),
  notify(notice) {
    clearTimeout(noticeTimer)
    set({ notice })
    if (notice) noticeTimer = setTimeout(() => set({ notice: null }), 4000)
  },
}))

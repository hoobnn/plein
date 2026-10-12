import type { ArrangeResult, CanvasMenuEvent, Engine, EngineState } from '@plein/canvas-core'
import { create } from 'zustand'
import { slideView } from '../ui/viewTransition'

export type SyncStatus = 'local' | 'connecting' | 'connected' | 'disconnected'

export interface NoticeAction {
  label: string
  run(): void
}

interface CanvasStore extends EngineState {
  engine: Engine | null
  sync: SyncStatus
  /** 正在导入的文件：已完成 / 总数 */
  importing: { done: number; total: number } | null
  notice: string | null
  /** 提示上的按钮（如“撤销”） */
  noticeAction: NoticeAction | null
  /** 远端画布 id；本地演示时为空（不能运行节点） */
  canvasId: string | null
  /** 当前弹出的画布菜单：节点选择器或右键菜单 */
  menu: CanvasMenuEvent | null
  /** 打开表格编辑器的分镜节点 */
  storyboard: string | null
  /** 打开编辑器的序列节点 */
  sequence: string | null
  /** 全屏查看的图片 / 视频 */
  viewer: { assetId: string; kind: 'image' | 'video'; name: string } | null
  /** 快捷键面板 */
  shortcuts: boolean
  /** 刚完成的整理：底部弹“保留 / 还原” */
  arranged: ArrangeResult | null
  /** 生成历史面板 */
  history: boolean
  /** 任务面板：排队、运行中和最近结束的任务 */
  tasks: boolean
  /** 画布视图：工作流（节点图）或故事板（按类型分栏的列表） */
  mode: 'flow' | 'board'
  /** 挂载引擎并把它的运行时状态镜像到 store（只在状态变化时更新，不跟随每帧） */
  attach(engine: Engine): () => void
  setSync(sync: SyncStatus): void
  setImporting(importing: { done: number; total: number } | null): void
  notify(notice: string | null, action?: NoticeAction): void
  setCanvasId(id: string | null): void
  setMenu(menu: CanvasMenuEvent | null): void
  openStoryboard(id: string | null): void
  openSequence(id: string | null): void
  view(v: CanvasStore['viewer']): void
  toggleShortcuts(open?: boolean): void
  setArranged(r: ArrangeResult | null): void
  toggleHistory(open?: boolean): void
  toggleTasks(open?: boolean): void
  setMode(mode: 'flow' | 'board'): void
}

const initial: EngineState = {
  tool: 'select',
  zoom: 1,
  selection: 0,
  canUndo: false,
  canRedo: false,
  edgesHidden: false,
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined

export const useCanvas = create<CanvasStore>((set) => ({
  ...initial,
  engine: null,
  sync: 'local',
  importing: null,
  notice: null,
  noticeAction: null,
  canvasId: null,
  menu: null,
  storyboard: null,
  sequence: null,
  viewer: null,
  shortcuts: false,
  arranged: null,
  history: false,
  tasks: false,
  mode: 'flow',
  attach(engine) {
    const sync = () => set(engine.state)
    const off = engine.onStateChange(sync)
    const offMenu = engine.onMenu((menu) => set({ menu }))
    const offArrange = engine.onArrange((arranged) => {
      set({ arranged })
      if (arranged.scope === 'canvas') engine.zoomToFit()
    })
    set({ engine, ...engine.state })
    return () => {
      off()
      offMenu()
      offArrange()
      set({
        engine: null,
        menu: null,
        storyboard: null,
        sequence: null,
        viewer: null,
        arranged: null,
        history: false,
        tasks: false,
        mode: 'flow',
        ...initial,
      })
    }
  },
  setCanvasId: (canvasId) => set({ canvasId }),
  setMenu: (menu) => set({ menu }),
  openStoryboard: (storyboard) => set({ storyboard }),
  openSequence: (sequence) => set({ sequence }),
  view: (viewer) => set({ viewer }),
  toggleShortcuts: (open) => set((s) => ({ shortcuts: open ?? !s.shortcuts })),
  setArranged: (arranged) => set({ arranged }),
  toggleHistory: (open) => set((s) => ({ history: open ?? !s.history })),
  toggleTasks: (open) => set((s) => ({ tasks: open ?? !s.tasks })),
  setMode: (mode) => set({ mode, menu: null }),
  setSync: (sync) => set({ sync }),
  setImporting: (importing) => set({ importing }),
  notify(notice, action) {
    clearTimeout(noticeTimer)
    set({ notice, noticeAction: action ?? null })
    // 带按钮的多留一会儿，来得及点
    if (notice)
      noticeTimer = setTimeout(
        () => set({ notice: null, noticeAction: null }),
        action ? 8000 : 4000,
      )
  },
}))

const MODE_ORDER: Array<CanvasStore['mode']> = ['flow', 'board']

/** 切换工作流 / 故事板，带整页滑动：按按钮的左右顺序决定方向 */
export function switchMode(mode: CanvasStore['mode']) {
  const { mode: from, engine, setMode } = useCanvas.getState()
  if (from === mode) return
  // 故事板里看不到选区，切过去时清掉，免得按删除键误删
  if (mode === 'board') engine?.selection.clear()
  slideView(MODE_ORDER.indexOf(mode) > MODE_ORDER.indexOf(from) ? 'next' : 'prev', () =>
    setMode(mode),
  )
}

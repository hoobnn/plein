import type { ArrangeResult, CanvasMenuEvent, Engine, EngineState } from '@plein/canvas-core'
import { create } from 'zustand'
import { cancelViewTransition, slideView } from '../ui/viewTransition'
import type { AiAnalysisTarget } from '../features/ai-shot-analysis/AiAnalysisEditor'

/**
 * 画布文档的同步状态：
 * - connecting：还没有可显示的内容，等服务端
 * - cached：先显示的本机缓存，还没和服务端对上
 * - syncing：连上了，正在交换差异
 * - connected：已和服务端对齐，之后的改动实时发送
 * - disconnected：断线；改动留在本机（有缓存时也存进 IndexedDB），重连后自动合并
 */
export type SyncStatus =
  | 'local'
  | 'connecting'
  | 'cached'
  | 'syncing'
  | 'connected'
  | 'disconnected'

export interface NoticeAction {
  label: string
  run(): void
}

interface CanvasStore extends EngineState {
  engine: Engine | null
  /** 当前画布持有的临时素材地址，随引擎分离清空。 */
  localAssetUrls: ReadonlyMap<string, string> | null
  sync: SyncStatus
  /** 本机缓存（IndexedDB）可用；是否写入完成另由 cacheSaved 表示 */
  localCache: boolean
  cacheSaved: boolean
  /** 正在导入的文件：已完成 / 总数 */
  importing: { done: number; total: number } | null
  notice: string | null
  noticeScope: 'canvas' | 'app'
  /** 提示上的按钮（如“撤销”） */
  noticeAction: NoticeAction | null
  /** 远端画布 id；本地演示时为空（不能运行节点） */
  canvasId: string | null
  /** 当前弹出的画布菜单：节点选择器或右键菜单 */
  menu: CanvasMenuEvent | null
  /** 打开表格编辑器的分镜节点 */
  storyboard: string | null
  shotWorkbench: { boardId: string; shotId: string } | null
  /** 打开编辑器的序列节点 */
  sequence: string | null
  sequenceReturn: { sequenceId: string; boardId: string; canvasId: string | null } | null
  sequenceFocus: { sequenceId: string; clipInstanceId: string; requestId: number } | null
  /** 打开编辑器的 3D 构图节点 */
  stage: string | null
  shotAnalysis: string | null
  aiAnalysis: AiAnalysisTarget | null
  /** 打开编辑器的动态合成节点 */
  motion: string | null
  /** 全屏查看的图片 / 视频 */
  viewer: {
    assetId?: string
    kind: 'image' | 'video' | 'audio' | 'result'
    name: string
    nodeId?: string
    resultId?: string
  } | null
  /** 快捷键面板 */
  shortcuts: boolean
  /** 刚完成的整理：底部弹“保留 / 还原” */
  arranged: ArrangeResult | null
  /** 生成历史面板 */
  history: boolean
  /** 任务面板：排队、运行中和最近结束的任务 */
  tasks: boolean
  /** 「查看影响」面板 */
  impact: boolean
  /** 画布视图：工作流（节点图）或故事板（按类型分栏的列表） */
  mode: 'flow' | 'board'
  /** 挂载引擎并把它的运行时状态镜像到 store（只在状态变化时更新，不跟随每帧） */
  attach(engine: Engine, localAssetUrls?: ReadonlyMap<string, string>): () => void
  setSync(sync: SyncStatus, localCache?: boolean): void
  setCacheSaved(saved: boolean): void
  setImporting(importing: { done: number; total: number } | null): void
  notify(notice: string | null, action?: NoticeAction, scope?: 'canvas' | 'app'): void
  setCanvasId(id: string | null): void
  setMenu(menu: CanvasMenuEvent | null): void
  openStoryboard(id: string | null): void
  openShotWorkbench(target: { boardId: string; shotId: string } | null): void
  openSequence(id: string | null, clipInstanceId?: string, returnBoardId?: string): void
  consumeSequenceFocus(requestId: number): void
  openStage(id: string | null): void
  openShotAnalysis(id: string | null): void
  openAiAnalysis(target: AiAnalysisTarget | null): void
  openMotion(id: string | null): void
  view(v: CanvasStore['viewer']): void
  toggleShortcuts(open?: boolean): void
  setArranged(r: ArrangeResult | null): void
  toggleHistory(open?: boolean): void
  toggleTasks(open?: boolean): void
  toggleImpact(open?: boolean): void
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
let sequenceFocusRequest = 0

export const useCanvas = create<CanvasStore>((set, get) => ({
  ...initial,
  engine: null,
  localAssetUrls: null,
  sync: 'local',
  localCache: true,
  cacheSaved: true,
  importing: null,
  notice: null,
  noticeScope: 'canvas',
  noticeAction: null,
  canvasId: null,
  menu: null,
  storyboard: null,
  shotWorkbench: null,
  sequence: null,
  sequenceReturn: null,
  sequenceFocus: null,
  stage: null,
  shotAnalysis: null,
  aiAnalysis: null,
  motion: null,
  viewer: null,
  shortcuts: false,
  arranged: null,
  history: false,
  tasks: false,
  impact: false,
  mode: 'flow',
  attach(engine, localAssetUrls) {
    const sync = () => set(engine.state)
    const off = engine.onStateChange(sync)
    const offMenu = engine.onMenu((menu) => set({ menu }))
    const offArrange = engine.onArrange((arranged) => {
      set({ arranged })
      if (arranged.scope === 'canvas') engine.zoomToFit()
    })
    set({ engine, localAssetUrls: localAssetUrls ?? null, ...engine.state })
    return () => {
      off()
      offMenu()
      offArrange()
      const keepNotice = get().noticeScope === 'app'
      if (!keepNotice) clearTimeout(noticeTimer)
      set({
        engine: null,
        localAssetUrls: null,
        importing: null,
        ...(!keepNotice
          ? { notice: null, noticeAction: null, noticeScope: 'canvas' as const }
          : {}),
        menu: null,
        storyboard: null,
        shotWorkbench: null,
        sequence: null,
        sequenceReturn: null,
        sequenceFocus: null,
        stage: null,
        shotAnalysis: null,
        aiAnalysis: null,
        motion: null,
        viewer: null,
        arranged: null,
        history: false,
        tasks: false,
        impact: false,
        mode: 'flow',
        ...initial,
      })
    }
  },
  setCacheSaved: (cacheSaved) => set({ cacheSaved }),
  setCanvasId: (canvasId) => set({ canvasId }),
  setMenu: (menu) => set({ menu }),
  openStoryboard: (storyboard) =>
    set({ storyboard, ...(storyboard ? { shotWorkbench: null } : {}) }),
  openShotWorkbench: (shotWorkbench) =>
    set({
      shotWorkbench,
      ...(shotWorkbench
        ? {
            storyboard: null,
            sequence: null,
            sequenceReturn: null,
            sequenceFocus: null,
            viewer: null,
          }
        : {}),
    }),
  openSequence: (sequence, clipInstanceId, returnBoardId) =>
    set({
      sequence,
      sequenceReturn:
        sequence && returnBoardId
          ? { sequenceId: sequence, boardId: returnBoardId, canvasId: get().canvasId }
          : null,
      sequenceFocus:
        sequence && clipInstanceId
          ? { sequenceId: sequence, clipInstanceId, requestId: ++sequenceFocusRequest }
          : null,
      ...(sequence ? { shotWorkbench: null } : {}),
    }),
  consumeSequenceFocus: (requestId) => {
    if (get().sequenceFocus?.requestId === requestId) set({ sequenceFocus: null })
  },
  openStage: (stage) => set({ stage }),
  openShotAnalysis: (shotAnalysis) => set({ shotAnalysis }),
  openAiAnalysis: (aiAnalysis) => set({ aiAnalysis }),
  openMotion: (motion) => set({ motion }),
  view: (viewer) => set({ viewer }),
  toggleShortcuts: (open) => set((s) => ({ shortcuts: open ?? !s.shortcuts })),
  setArranged: (arranged) => set({ arranged }),
  toggleHistory: (open) => set((s) => ({ history: open ?? !s.history })),
  toggleTasks: (open) => set((s) => ({ tasks: open ?? !s.tasks })),
  toggleImpact: (open) => set((s) => ({ impact: open ?? !s.impact })),
  setMode: (mode) => set({ mode, menu: null }),
  setSync: (sync, localCache) => set(localCache === undefined ? { sync } : { sync, localCache }),
  setImporting: (importing) => set({ importing }),
  notify(notice, action, scope = 'canvas') {
    clearTimeout(noticeTimer)
    set({ notice, noticeAction: action ?? null, noticeScope: scope })
    // 带按钮的多留一会儿，来得及点
    if (notice)
      noticeTimer = setTimeout(
        () => set({ notice: null, noticeAction: null, noticeScope: 'canvas' }),
        action ? 8000 : 4000,
      )
  },
}))

const MODE_ORDER: Array<CanvasStore['mode']> = ['flow', 'board']

/** 切换工作流 / 故事板，带整页滑动：按按钮的左右顺序决定方向 */
export function switchMode(mode: CanvasStore['mode']) {
  const { mode: from, engine, setMode } = useCanvas.getState()
  if (from === mode) {
    cancelViewTransition()
    return
  }
  // 故事板里看不到选区，切过去时清掉，免得按删除键误删
  if (mode === 'board') engine?.selection.clear()
  slideView(MODE_ORDER.indexOf(mode) > MODE_ORDER.indexOf(from) ? 'next' : 'prev', () =>
    setMode(mode),
  )
}

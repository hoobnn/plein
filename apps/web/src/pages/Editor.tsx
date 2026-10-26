import { useQuery } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { api } from '../api/client'
import { ShotWorkbench } from '../features/storyboard/ShotWorkbench'
import { queryKeys } from '../api/query'
import { type CanvasSource, CanvasView } from '../canvas/CanvasView'
import { placeStartNode } from '../canvas/start'
import { watchStartNode } from '../canvas/startQueue'
import { CanvasMenus } from '../shell/CanvasMenus'
import { CanvasStart } from '../shell/CanvasStart'
import { AgentCursor } from '../features/agent/AgentCursor'
import { useAgent } from '../features/agent/store'
import { CommandPalette } from '../shell/CommandPalette'
import { ArrangeToast } from '../shell/ArrangeToast'
import { Board } from '../shell/Board'
import { FrameBar } from '../shell/FrameBar'
import { Generator } from '../features/generator/Generator'
import { History } from '../shell/History'
import { ProjectSwitcher } from '../features/projects/ProjectSwitcher'
import { CanvasInfo } from '../features/projects/CanvasInfo'
import { ResultBar } from '../shell/ResultBar'
import { Viewer } from '../shell/Viewer'
import { SelectionBar } from '../shell/SelectionBar'
import { Shortcuts } from '../shell/Shortcuts'
import { Sidebar } from '../shell/Sidebar'
import { SequenceEditor } from '../features/sequence/SequenceEditor'
import { StageEditor } from '../features/stage/StageEditor'
import { ShotAnalysisEditor } from '../features/shot-analysis/ShotAnalysisEditor'
import { AiAnalysisEditor } from '../features/ai-shot-analysis/AiAnalysisEditor'
import { StoryboardEditor } from '../features/storyboard/StoryboardEditor'
import { Tasks } from '../features/runs/Tasks'
import { ImpactPanel } from '../features/runs/ImpactPanel'
import { Toolbar, ViewControls } from '../shell/Toolbar'
import { Brand, isPlainClick } from '../ui/Brand'
import { Icon } from '../ui/icons'
import { MOD, withShortcut } from '../ui/keys'
import { SlidePill } from '../ui/Slide'
import { EditorActions } from '../shell/EditorActions'
import { useCatalog } from '../stores/catalog'
import { useLibrary } from '../features/library/store'
import { type SyncStatus, switchMode, useCanvas } from '../stores/canvas'
import { useSidebar } from '../stores/sidebar'
import { useTemplates } from '../features/templates/store'
import { navigate } from '../router'
import { Presence } from '../ui/Presence'
import { zoomView } from '../ui/viewTransition'
import { Toast } from '../ui/Toast'
import { useShallow } from 'zustand/react/shallow'

const SYNC_LABELS: Record<SyncStatus, string> = {
  local: '本地演示',
  connecting: '连接中…',
  cached: '本机缓存 · 连接中…',
  syncing: '同步中…',
  connected: '已同步',
  disconnected: '离线 · 改动先存在本机',
}
/** 悬停时的完整说明 */
const SYNC_HINTS: Record<SyncStatus, string> = {
  local: '本地演示，不保存',
  connecting: '正在连接本机服务',
  cached: '先显示上次打开时存在本机的画布，连上服务后补齐差异',
  syncing: '已连上服务，正在交换差异',
  connected: '已同步，改动实时保存到本机服务',
  disconnected: '离线：改动先存在浏览器里，恢复连接后自动同步；没加载过的素材暂时显示不了',
}
/** 没有本机缓存（隐私模式等）时断线：改动只在这个页面里 */
const VOLATILE = {
  label: '离线 · 改动未保存',
  hint: '离线：浏览器存不了缓存，改动只在这个页面里，关闭或刷新会丢失；恢复连接后自动同步',
}

export function Editor({
  source,
  onOpenSettings,
}: {
  source: CanvasSource
  onOpenSettings(): void
}) {
  // 只取用到的字段：整个 store 会随相机缩放、选中等频繁更新，不能让整页跟着重渲染
  const { sync, importing, notice, noticeAction, mode } = useCanvas(
    useShallow((s) => ({
      sync: s.sync,
      importing: s.importing,
      notice: s.notice,
      noticeAction: s.noticeAction,
      mode: s.mode,
    })),
  )
  const canvasId = source.kind === 'remote' ? source.canvasId : null
  const canvasQuery = useQuery({
    queryKey: queryKeys.canvas(canvasId ?? ''),
    queryFn: () => api.canvas(canvasId!),
    enabled: !!canvasId,
  })
  const canvas = canvasQuery.data ?? null

  const engine = useCanvas((s) => s.engine)
  const catalog = useCatalog((s) => s.catalog)
  useEffect(() => {
    if (!engine || !catalog || !canvasId) return
    const place = () => {
      const current = useCanvas.getState()
      if (current.engine === engine && current.canvasId === canvasId && !engine.doc.readOnly)
        placeStartNode(engine, catalog, canvasId)
    }
    place()
    return watchStartNode(canvasId, place)
  }, [engine, catalog, canvasId])

  useEffect(() => {
    if (!canvasId) return
    void useCatalog.getState().load()
    void useTemplates.getState().load()
    void useLibrary.getState().load()
  }, [canvasId])
  // 资产库的「本项目」与新建条目的默认归属跟着当前画布走
  useEffect(() => {
    useLibrary.getState().setProject(canvas?.projectId ?? null)
    return () => useLibrary.getState().setProject(null)
  }, [canvas?.projectId])

  const sidebarOpen = useSidebar((s) => s.open)
  const sidebarWidth = useSidebar((s) => s.width)
  const assistantOpen = useAgent((s) => s.open)
  const tasksOpen = useCanvas((s) => s.tasks)
  const externalRightPanelWidth = assistantOpen ? 424 : tasksOpen ? 372 : 0
  const [guideWidth, setGuideWidth] = useState(0)
  const rightPanelWidth = externalRightPanelWidth || guideWidth
  const [sidebarOverlay, setSidebarOverlay] = useState(false)
  const roomForPanels = usePanelSpace(sidebarWidth, rightPanelWidth)
  const sidebar =
    mode === 'flow' && sidebarOpen && (roomForPanels || (sidebarOverlay && !rightPanelWidth))
  const roomForGuide = usePanelSpace(sidebar ? sidebarWidth : 0, 0, 960)
  const roomForHint = usePanelSpace(sidebar ? sidebarWidth : 0, rightPanelWidth, 240)
  const guidePresentation =
    mode === 'flow' && roomForGuide && !externalRightPanelWidth ? 'floating' : 'modal'
  useEffect(() => {
    if (rightPanelWidth) setSidebarOverlay(false)
  }, [rightPanelWidth])
  const toggleSidebar = useCallback(() => {
    if (!sidebar && !roomForPanels) {
      useAgent.getState().toggle(false)
      useCanvas.getState().toggleTasks(false)
    }
    setSidebarOverlay(!sidebar && !roomForPanels)
    useSidebar.getState().toggle(!sidebar)
  }, [sidebar, roomForPanels])
  // 侧栏浮在画布上：告诉相机左边被挡住多少，适应画布、定位时把内容放在右边的可见区域
  useLayoutEffect(() => {
    engine?.camera.setInsets({ left: sidebar ? sidebarWidth + 12 : 0 })
  }, [engine, sidebar, sidebarWidth])

  // 右侧浮动面板共用可见区域，避免各自清理时覆盖另一面板的边距。
  useLayoutEffect(() => {
    if (!engine) return
    const desktop = window.matchMedia('(min-width: 640px)')
    const sync = () => engine.camera.setInsets({ right: desktop.matches ? rightPanelWidth : 0 })
    sync()
    desktop.addEventListener('change', sync)
    return () => {
      desktop.removeEventListener('change', sync)
      engine.camera.setInsets({ right: 0 })
    }
  }, [engine, rightPanelWidth])

  return (
    <div className="app-stage relative h-full w-full">
      <CanvasView
        source={source}
        guidePresentation={guidePresentation}
        onGuideWidthChange={setGuideWidth}
      />
      <Board />
      {/* 侧栏是浮在画布左侧的面板：开关只滑入滑出，顶栏和画布都不动 */}
      {mode === 'flow' && <Sidebar open={sidebar} />}
      <header className="app-titlebar app-viewbar pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-3">
        <div className="app-drag ui-bar pointer-events-auto min-w-0">
          {/* 故事板没有侧栏，开关保留但禁用，切换视图时后面的按钮不挪位置 */}
          <SidebarToggle open={sidebar} disabled={mode !== 'flow'} onToggle={toggleSidebar} />
          <div className="ui-bar-sep" />
          <Brand
            compactOnMobile
            onClick={(e) => {
              if (!isPlainClick(e)) return
              e.preventDefault()
              const projectId = canvas?.projectId
              zoomView('leave', () => navigate({ name: 'home' }), {
                to: () =>
                  projectId
                    ? document.querySelector(
                        `[data-project="${CSS.escape(projectId)}"] .home-cover`,
                      )
                    : null,
              })
            }}
          />
          <span className="text-ink-subtle" aria-hidden="true">
            /
          </span>
          {canvas ? (
            <div className="editor-project flex min-w-0 items-center gap-0.5">
              <ProjectSwitcher canvas={canvas} />
            </div>
          ) : source.kind === 'demo' ? (
            <span
              title={`演示（${source.count} 个元素）`}
              className="ui-bar-btn min-w-0 max-w-60 shrink font-medium text-ink"
            >
              <span className="truncate">{`演示（${source.count} 个元素）`}</span>
            </span>
          ) : null}
          {source.kind === 'remote' && <CanvasInfo query={canvasQuery} />}
          <SyncDot sync={sync} />
          <div className="ui-bar-sep" />
          <ModeSwitch />
          <span id="plein-creation-guide-entry" className="inline-flex empty:hidden" />
        </div>
        <EditorActions
          remote={source.kind === 'remote'}
          projectId={canvas?.projectId}
          canvasId={canvasId}
          onOpenSettings={onOpenSettings}
        />
      </header>
      {mode === 'flow' && <EmptyHint hidden={!roomForHint} rightPanel={!!rightPanelWidth} />}
      <Presence>
        {(importing || notice) && (
          <Toast
            action={
              !importing &&
              noticeAction && (
                <button
                  type="button"
                  className="ui-btn ui-btn-sm"
                  onClick={() => {
                    useCanvas.getState().notify(null)
                    noticeAction.run()
                  }}
                >
                  {noticeAction.label}
                </button>
              )
            }
          >
            {importing ? `正在导入 ${importing.done}/${importing.total}…` : notice}
          </Toast>
        )}
      </Presence>
      {mode === 'flow' && (
        <>
          <Generator />
          <ResultBar />
          <FrameBar remote={source.kind === 'remote'} />
          <SelectionBar remote={source.kind === 'remote'} />
          <ArrangeToast />
          <CanvasMenus canImport={source.kind === 'remote'} />
          {/* 底栏从侧栏右边开始，跟侧栏同一条曲线滑动：视图工具条靠左，主工具条在可见画布里居中，空间不够时往右让 */}
          <footer
            className="plein-follow-sidebar plein-footer pointer-events-none absolute right-0 bottom-0 z-30 p-3"
            style={{ left: sidebar ? sidebarWidth + 12 : 0 }}
          >
            <div className="max-sm:hidden">
              <ViewControls />
            </div>
            <Toolbar canImport={source.kind === 'remote'} />
          </footer>
        </>
      )}
      <StoryboardEditor />
      <ShotWorkbench />
      <SequenceEditor />
      <StageEditor />
      <ShotAnalysisEditor />
      <AiAnalysisEditor />
      <Shortcuts />
      <CommandPalette canvasId={canvasId} />
      <AgentCursor />
      <History />
      {source.kind === 'remote' && <Tasks />}
      {source.kind === 'remote' && <ImpactPanel />}
      <Viewer />
    </div>
  )
}

const SIDEBAR_KEY = 'mod+\\'

/** 两侧面板之间至少保留 320px 画布；临时隐藏不改写侧栏偏好。 */
function usePanelSpace(sidebarWidth: number, rightPanelWidth: number, canvasWidth = 320) {
  const media = useMemo(
    () => window.matchMedia(`(min-width: ${sidebarWidth + 12 + rightPanelWidth + canvasWidth}px)`),
    [sidebarWidth, rightPanelWidth, canvasWidth],
  )
  const subscribe = useCallback(
    (notify: () => void) => {
      media.addEventListener('change', notify)
      return () => media.removeEventListener('change', notify)
    },
    [media],
  )
  return useSyncExternalStore(subscribe, () => media.matches)
}

/** 侧栏开关：工作流左上工具条的第一个按钮，快捷键 ⌘\ */
function SidebarToggle({
  open,
  disabled,
  onToggle,
}: {
  open: boolean
  disabled: boolean
  onToggle(): void
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.code !== 'Backslash' && e.key !== '\\') ||
        !(e.metaKey || e.ctrlKey) ||
        e.shiftKey ||
        e.altKey
      )
        return
      if (useCanvas.getState().mode !== 'flow') return
      e.preventDefault()
      onToggle()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onToggle])
  const label = open ? '收起侧栏' : '展开侧栏'
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={label}
      title={disabled ? '侧栏只在工作流里显示' : withShortcut(label, SIDEBAR_KEY)}
      className="ui-bar-btn"
    >
      <Icon name={open ? 'sidebarClose' : 'sidebarOpen'} />
    </button>
  )
}

/** 同步状态：正常同步时只留一个点，异常才写出来 */
function SyncDot({ sync }: { sync: SyncStatus }) {
  const localCache = useCanvas((s) => s.localCache)
  const cacheSaved = useCanvas((s) => s.cacheSaved)
  const volatile = sync === 'disconnected' && !localCache
  const pending = sync === 'disconnected' && localCache && !cacheSaved
  const label = volatile ? VOLATILE.label : pending ? '离线 · 正在保存到本机' : SYNC_LABELS[sync]
  const hint = volatile
    ? VOLATILE.hint
    : pending
      ? '离线改动正在写入浏览器缓存，请等待保存完成后再刷新或关闭'
      : SYNC_HINTS[sync]
  return (
    <span
      className={`flex min-w-0 items-center gap-1.5 px-2 text-xs ${sync === 'disconnected' ? 'text-warning' : 'text-ink-subtle'}`}
      title={hint}
      data-testid="sync-status"
      data-sync={sync}
      data-cache={!localCache ? 'unavailable' : cacheSaved ? 'saved' : 'saving'}
    >
      <span
        className={`size-1.5 rounded-full ${sync === 'connected' ? 'bg-success' : sync === 'disconnected' ? 'bg-warning' : 'bg-ink-subtle'}`}
        aria-hidden="true"
      />
      <span className={sync === 'connected' || sync === 'local' ? 'sr-only' : 'truncate'}>
        {label}
      </span>
    </span>
  )
}

/** 空画布时在中央给一句上手提示，放下第一个元素后消失 */
function EmptyHint({ hidden, rightPanel }: { hidden: boolean; rightPanel: boolean }) {
  const engine = useCanvas((s) => s.engine)
  const empty = useSyncExternalStore(
    useCallback((notify) => engine?.doc.subscribe(notify) ?? (() => {}), [engine]),
    () => !!engine && engine.scene.children(null).length === 0,
  )
  const insets = useSyncExternalStore(
    useCallback((notify) => engine?.camera.onInsetsChange(notify) ?? (() => {}), [engine]),
    () => engine?.camera.insets ?? null,
  )
  // 手机上的右面板覆盖整张画布，不占相机边距，此时隐藏背景提示。
  if (!empty || hidden || (rightPanel && !insets?.right)) return null
  return (
    <div
      style={{ left: insets?.left ?? 0, right: insets?.right ?? 0 }}
      className="pointer-events-none absolute inset-y-0"
    >
      {/* 快捷创建入口靠上摆：画布中央留给双击添加节点，入口不能挡住这个手势 */}
      <div className="absolute inset-x-0 top-20 flex justify-center px-6">
        {engine && (
          <div className="w-full min-w-0 max-w-xl">
            <CanvasStart engine={engine} />
          </div>
        )}
      </div>
      <div className="absolute inset-y-0 flex items-center justify-center px-6 pt-20 pb-24">
        <div className="flex w-full min-w-0 max-w-xl flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
            <span className="ui-keycap">双击</span>或<span className="ui-keycap">Tab</span>
          </div>
          <p className="max-w-full break-words text-sm text-ink-muted">
            双击空白处或按 Tab 添加节点
          </p>
          <p className="max-w-full break-words text-xs text-ink-subtle">
            也可以把图片、视频、音频拖进来 · {MOD} + 滚轮缩放 · 按 ? 查看快捷键
          </p>
        </div>
      </div>
    </div>
  )
}

const MODES = [
  { mode: 'flow', label: '工作流', icon: 'workflow' },
  { mode: 'board', label: '故事板', icon: 'board' },
] as const

/** 工作流 / 故事板切换（左上角的两个图标） */
function ModeSwitch() {
  const mode = useCanvas((s) => s.mode)
  return (
    <div className="ui-slide flex gap-0.5">
      <SlidePill />
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          aria-label={m.label}
          title={m.label}
          aria-pressed={mode === m.mode}
          onClick={() => switchMode(m.mode)}
          className={`ui-bar-btn ${m.mode === mode ? 'max-sm:hidden' : ''}`}
        >
          <Icon name={m.icon} />
        </button>
      ))}
    </div>
  )
}

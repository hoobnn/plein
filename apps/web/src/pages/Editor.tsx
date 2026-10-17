import type { Canvas } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { type CanvasSource, CanvasView } from '../canvas/CanvasView'
import { placeStartNode } from '../canvas/start'
import { CanvasMenus } from '../shell/CanvasMenus'
import { AgentCursor } from '../features/agent/AgentCursor'
import { CommandPalette } from '../shell/CommandPalette'
import { ArrangeToast } from '../shell/ArrangeToast'
import { Board } from '../shell/Board'
import { FrameBar } from '../shell/FrameBar'
import { Generator } from '../features/generator/Generator'
import { History } from '../shell/History'
import { ProjectSwitcher } from '../features/projects/ProjectSwitcher'
import { ResultBar } from '../shell/ResultBar'
import { Viewer } from '../shell/Viewer'
import { SelectionBar } from '../shell/SelectionBar'
import { Shortcuts } from '../shell/Shortcuts'
import { Sidebar } from '../shell/Sidebar'
import { SequenceEditor } from '../features/sequence/SequenceEditor'
import { StageEditor } from '../features/stage/StageEditor'
import { StoryboardEditor } from '../features/storyboard/StoryboardEditor'
import { Tasks } from '../features/runs/Tasks'
import { ImpactPanel } from '../features/runs/ImpactPanel'
import { Toolbar, ViewControls } from '../shell/Toolbar'
import { Brand, isPlainClick } from '../ui/Brand'
import { Icon } from '../ui/icons'
import { MOD, withShortcut } from '../ui/keys'
import { SlidePill } from '../ui/Slide'
import { ThemeToggle } from '../ui/ThemeToggle'
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
import { useMediaLibrary } from '../features/media-library/store'
import { useCheckpoints } from '../features/checkpoints/store'

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
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const canvasId = source.kind === 'remote' ? source.canvasId : null

  const engine = useCanvas((s) => s.engine)
  const catalog = useCatalog((s) => s.catalog)
  useEffect(() => {
    if (engine && catalog && canvasId) placeStartNode(engine, catalog, canvasId)
  }, [engine, catalog, canvasId])

  useEffect(() => {
    if (!canvasId) return
    api.canvas(canvasId).then(setCanvas, () => setCanvas(null))
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
  const sidebar = mode === 'flow' && sidebarOpen
  // 侧栏浮在画布上：告诉相机左边被挡住多少，适应画布、定位时把内容放在右边的可见区域
  useEffect(() => {
    engine?.camera.setInsets({ left: sidebar ? sidebarWidth + 12 : 0 })
  }, [engine, sidebar, sidebarWidth])

  return (
    <div className="app-stage relative h-full w-full">
      <CanvasView source={source} />
      <Board />
      {/* 侧栏是浮在画布左侧的面板：开关只滑入滑出，顶栏和画布都不动 */}
      {mode === 'flow' && <Sidebar open={sidebarOpen} />}
      <header className="app-titlebar app-viewbar pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-3">
        <div className="app-drag ui-bar pointer-events-auto">
          {/* 故事板没有侧栏，开关保留但禁用，切换视图时后面的按钮不挪位置 */}
          <SidebarToggle open={sidebar} disabled={mode !== 'flow'} />
          <div className="ui-bar-sep" />
          <Brand
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
            <ProjectSwitcher canvas={canvas} onCanvas={setCanvas} />
          ) : (
            <span className="ui-bar-btn block max-w-60 truncate font-medium text-ink">
              {source.kind === 'demo' ? `演示（${source.count} 个元素）` : '…'}
            </span>
          )}
          <SyncDot sync={sync} />
          <div className="ui-bar-sep" />
          <ModeSwitch />
        </div>
        <div className="app-actions ui-bar pointer-events-auto">
          {source.kind === 'remote' && (
            <>
              <button
                type="button"
                className="ui-bar-btn gap-1.5"
                onClick={() =>
                  useMediaLibrary.getState().show({ projectId: canvas?.projectId ?? undefined })
                }
              >
                <Icon name="image" />
                素材
              </button>
              <button
                type="button"
                className="ui-bar-btn gap-1.5"
                disabled={!canvas?.projectId}
                onClick={() => {
                  if (canvas?.projectId && canvasId)
                    useCheckpoints.getState().show({ projectId: canvas.projectId, canvasId })
                }}
              >
                <Icon name="history" />
                检查点
              </button>
              <button
                type="button"
                onClick={() => useLibrary.getState().show('character')}
                title="资产库：角色、场景、道具、风格、特效"
                className="ui-bar-btn gap-1.5"
              >
                <Icon name="library" />
                资产库
              </button>
              <div className="ui-bar-sep" />
            </>
          )}
          <ThemeToggle />
          {source.kind === 'remote' && (
            <>
              <div className="ui-bar-sep" />
              <button
                type="button"
                onClick={onOpenSettings}
                aria-label="设置"
                title="设置"
                className="ui-bar-btn"
              >
                <Icon name="settings" />
              </button>
            </>
          )}
        </div>
      </header>
      {mode === 'flow' && <EmptyHint />}
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
      <SequenceEditor />
      <StageEditor />
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

/** 侧栏开关：工作流左上工具条的第一个按钮，快捷键 ⌘\ */
function SidebarToggle({ open, disabled }: { open: boolean; disabled: boolean }) {
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
      useSidebar.getState().toggle()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const label = open ? '收起侧栏' : '展开侧栏'
  return (
    <button
      type="button"
      onClick={() => useSidebar.getState().toggle()}
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
function EmptyHint() {
  const engine = useCanvas((s) => s.engine)
  const [empty, setEmpty] = useState(false)
  useEffect(() => {
    if (!engine) return
    const check = () => setEmpty(engine.scene.children(null).length === 0)
    check()
    return engine.doc.subscribe(check)
  }, [engine])
  if (!empty) return null
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
          <span className="ui-keycap">双击</span>或<span className="ui-keycap">Tab</span>
        </div>
        <p className="text-sm text-ink-muted">双击空白处或按 Tab 添加节点</p>
        <p className="text-xs text-ink-subtle">
          也可以把图片、视频、音频拖进来 · {MOD} + 滚轮缩放 · 按 ? 查看快捷键
        </p>
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
          className="ui-bar-btn"
        >
          <Icon name={m.icon} />
        </button>
      ))}
    </div>
  )
}

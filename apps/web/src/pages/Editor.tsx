import type { Canvas } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { desktop } from '../desktop'
import { type CanvasSource, CanvasView } from '../canvas/CanvasView'
import { placeStartNode } from '../canvas/start'
import { CanvasMenus } from '../panels/CanvasMenus'
import { ArrangeToast } from '../panels/ArrangeToast'
import { Board } from '../panels/Board'
import { FrameBar } from '../panels/FrameBar'
import { Generator } from '../panels/Generator'
import { History } from '../panels/History'
import { ResultBar, Viewer } from '../panels/ResultBar'
import { SelectionBar } from '../panels/SelectionBar'
import { Shortcuts } from '../panels/Shortcuts'
import { StoryboardEditor } from '../panels/StoryboardEditor'
import { Toolbar, ViewControls } from '../panels/Toolbar'
import { Icon } from '../ui/icons'
import { InlineTitle } from '../ui/InlineTitle'
import { ThemeToggle } from '../ui/ThemeToggle'
import { useCatalog } from '../stores/catalog'
import { type SyncStatus, useCanvas } from '../stores/canvas'
import { useTemplates } from '../stores/templates'

const SYNC_LABELS: Record<SyncStatus, string> = {
  local: '本地演示',
  connecting: '连接中…',
  connected: '已同步',
  disconnected: '离线，恢复连接后自动同步',
}

export function Editor({
  source,
  onOpenSettings,
}: {
  source: CanvasSource
  onOpenSettings(): void
}) {
  const mac = desktop ? desktop.platform === 'darwin' : /Mac/i.test(navigator.platform)
  const modifier = mac ? '⌘' : 'Ctrl'
  const { sync, importing, notice, mode } = useCanvas()
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
  }, [canvasId])

  const [renaming, setRenaming] = useState(false)
  const rename = async (title: string | null) => {
    setRenaming(false)
    if (canvas && title && title !== canvas.title)
      setCanvas(await api.renameCanvas(canvas.id, title))
  }

  return (
    <div className="relative h-full w-full">
      <CanvasView source={source} />
      <Board />
      <header className="app-titlebar pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-3">
        <div className="app-drag ui-float pointer-events-auto flex h-11 items-center gap-0.5 rounded-[14px] px-1.5 text-[13px]">
          <a
            href="#/"
            className="flex h-8 items-center gap-2 rounded-lg px-2 font-semibold tracking-wide hover:bg-hover"
          >
            <span className="plein-logo size-[18px]" aria-hidden="true" />
            Plein
          </a>
          <span className="text-ink-subtle">/</span>
          {renaming && canvas ? (
            <InlineTitle
              value={canvas.title}
              onDone={rename}
              className="h-7 w-52 rounded-lg px-2 font-medium"
            />
          ) : (
            <button
              type="button"
              onClick={() => setRenaming(source.kind === 'remote' && !!canvas)}
              title={source.kind === 'remote' ? '重命名' : undefined}
              className="h-8 max-w-60 truncate rounded-lg px-2 font-medium hover:bg-hover"
            >
              {source.kind === 'demo' ? `演示（${source.count} 个元素）` : (canvas?.title ?? '…')}
            </button>
          )}
          <span
            className={`flex items-center gap-1.5 px-1.5 text-xs ${sync === 'disconnected' ? 'text-warning' : 'text-ink-subtle'}`}
            title={SYNC_LABELS[sync]}
            data-testid="sync-status"
          >
            <span
              className={`size-1.5 rounded-full ${sync === 'connected' ? 'bg-success' : sync === 'disconnected' ? 'bg-warning' : 'bg-ink-subtle'}`}
              aria-hidden="true"
            />
            {/* 正常同步时只留一个点，异常才写出来 */}
            <span className={sync === 'connected' || sync === 'local' ? 'sr-only' : ''}>
              {SYNC_LABELS[sync]}
            </span>
          </span>
          <div className="mx-1 h-5 w-px bg-line" />
          <ModeSwitch />
        </div>
        <div className="ui-float pointer-events-auto flex h-11 items-center gap-1 rounded-[14px] px-1.5">
          <ThemeToggle />
          {source.kind === 'remote' && (
            <>
              <div className="mx-0.5 h-5 w-px bg-line" />
              <button
                type="button"
                onClick={onOpenSettings}
                aria-label="设置"
                title="设置"
                className="ui-btn ui-btn-quiet ui-icon-btn"
              >
                <Icon name="settings" />
              </button>
            </>
          )}
        </div>
      </header>
      {mode === 'flow' && <EmptyHint modifier={modifier} />}
      {(importing || notice) && (
        <div className="pointer-events-none absolute inset-x-0 top-[68px] z-30 flex justify-center px-4">
          <div className="ui-float rounded-[10px] px-3.5 py-2 text-[13px]">
            {importing ? `正在导入 ${importing.done}/${importing.total}…` : notice}
          </div>
        </div>
      )}
      {mode === 'flow' && (
        <>
          <Generator />
          <ResultBar />
          <FrameBar remote={source.kind === 'remote'} />
          <SelectionBar remote={source.kind === 'remote'} />
          <ArrangeToast />
          <CanvasMenus canImport={source.kind === 'remote'} />
          <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-center p-3">
            <div className="absolute bottom-3 left-3 max-sm:hidden">
              <ViewControls />
            </div>
            <Toolbar canImport={source.kind === 'remote'} />
          </footer>
        </>
      )}
      <StoryboardEditor />
      <Shortcuts />
      <History />
      <Viewer />
    </div>
  )
}

/** 空画布时在中央给一句上手提示，放下第一个元素后消失 */
function EmptyHint({ modifier }: { modifier: string }) {
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
        <div className="flex gap-2 text-ink-subtle">
          <span className="plein-empty-key">双击</span>
          <span className="plein-empty-key">Tab</span>
        </div>
        <p className="text-sm text-ink-muted">双击空白处或按 Tab 添加节点</p>
        <p className="text-xs text-ink-subtle">
          也可以把图片、视频、音频拖进来 · {modifier}+滚轮缩放 · 按 ? 查看快捷键
        </p>
      </div>
    </div>
  )
}

const MODES = [
  { mode: 'flow', label: '工作流', icon: 'node' },
  { mode: 'board', label: '故事板', icon: 'grid' },
] as const

/** 工作流 / 故事板切换（左上角的两个图标） */
function ModeSwitch() {
  const mode = useCanvas((s) => s.mode)
  const engine = useCanvas((s) => s.engine)
  return (
    <div className="flex gap-0.5">
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          aria-label={m.label}
          title={m.label}
          aria-pressed={mode === m.mode}
          onClick={() => {
            // 故事板里看不到选区，切过去时清掉，免得按删除键误删
            if (m.mode === 'board') engine?.selection.clear()
            useCanvas.getState().setMode(m.mode)
          }}
          className={`flex size-8 items-center justify-center rounded-lg transition-colors ${
            mode === m.mode ? 'bg-active text-ink' : 'text-ink-subtle hover:bg-hover hover:text-ink'
          }`}
        >
          <Icon name={m.icon} size={16} />
        </button>
      ))}
    </div>
  )
}

import type { Canvas } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { desktop } from '../desktop'
import { type CanvasSource, CanvasView } from '../canvas/CanvasView'
import { CanvasMenus } from '../panels/CanvasMenus'
import { ArrangeToast } from '../panels/ArrangeToast'
import { FrameBar } from '../panels/FrameBar'
import { Generator } from '../panels/Generator'
import { History } from '../panels/History'
import { ResultBar, Viewer } from '../panels/ResultBar'
import { SelectionBar } from '../panels/SelectionBar'
import { Shortcuts } from '../panels/Shortcuts'
import { StoryboardEditor } from '../panels/StoryboardEditor'
import { Toolbar } from '../panels/Toolbar'
import { Icon } from '../ui/icons'
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
  const { selection, sync, importing, notice } = useCanvas()
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const canvasId = source.kind === 'remote' ? source.canvasId : null

  useEffect(() => {
    if (!canvasId) return
    api.canvas(canvasId).then(setCanvas, () => setCanvas(null))
    void useCatalog.getState().load()
    void useTemplates.getState().load()
  }, [canvasId])

  const rename = async () => {
    if (!canvas) return
    const title = prompt('画布名称', canvas.title)?.trim()
    if (title && title !== canvas.title) setCanvas(await api.renameCanvas(canvas.id, title))
  }

  return (
    <div className="relative h-full w-full">
      <CanvasView source={source} />
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-3">
        <div className="ui-float pointer-events-auto flex h-11 items-center gap-0.5 rounded-[14px] px-1.5 text-[13px]">
          <a
            href="#/"
            className="flex h-8 items-center gap-2 rounded-lg px-2 font-semibold tracking-wide hover:bg-hover"
          >
            <span className="size-4 rounded-[5px] bg-accent" aria-hidden="true" />
            Plein
          </a>
          <span className="text-ink-subtle">/</span>
          <button
            type="button"
            onClick={rename}
            className="h-8 max-w-60 truncate rounded-lg px-2 font-medium hover:bg-hover"
          >
            {source.kind === 'demo' ? `演示（${source.count} 个元素）` : (canvas?.title ?? '…')}
          </button>
          <span
            className={`flex items-center gap-1.5 px-2 text-xs ${sync === 'disconnected' ? 'text-warning' : 'text-ink-subtle'}`}
            data-testid="sync-status"
          >
            <span
              className={`size-1.5 rounded-full ${sync === 'connected' ? 'bg-success' : sync === 'disconnected' ? 'bg-warning' : 'bg-ink-subtle'}`}
              aria-hidden="true"
            />
            {SYNC_LABELS[sync]}
          </span>
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
      <p className="pointer-events-none absolute bottom-5 left-4 hidden max-w-[calc(50%-300px)] text-xs leading-relaxed text-ink-subtle 2xl:block">
        {selection > 0 ? `已选 ${selection} 个 · ` : ''}双击空白处或按 Tab 添加节点 · 悬停节点从 +
        拖出连线 · 右键更多操作 · {modifier}+滚轮缩放 · 按 ? 查看快捷键
      </p>
      {(importing || notice) && (
        <div className="pointer-events-none absolute inset-x-0 top-[68px] z-30 flex justify-center px-4">
          <div className="ui-float rounded-[10px] px-3.5 py-2 text-[13px]">
            {importing ? `正在导入 ${importing.done}/${importing.total}…` : notice}
          </div>
        </div>
      )}
      <Generator />
      <ResultBar />
      <FrameBar remote={source.kind === 'remote'} />
      <SelectionBar remote={source.kind === 'remote'} />
      <ArrangeToast />
      <CanvasMenus canImport={source.kind === 'remote'} />
      <StoryboardEditor />
      <Shortcuts />
      <History />
      <Viewer />
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
        <Toolbar canImport={source.kind === 'remote'} />
      </footer>
    </div>
  )
}

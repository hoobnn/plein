import type { Canvas } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { type CanvasSource, CanvasView } from '../canvas/CanvasView'
import { SettingsDialog } from '../panels/Settings'
import { Toolbar } from '../panels/Toolbar'
import { useCatalog } from '../stores/catalog'
import { type SyncStatus, useCanvas } from '../stores/canvas'

const SYNC_LABELS: Record<SyncStatus, string> = {
  local: '本地演示',
  connecting: '连接中…',
  connected: '已同步',
  disconnected: '离线，恢复连接后自动同步',
}

export function Editor({ source }: { source: CanvasSource }) {
  const { selection, sync, importing, notice } = useCanvas()
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [settings, setSettings] = useState(false)
  const canvasId = source.kind === 'remote' ? source.canvasId : null

  useEffect(() => {
    if (!canvasId) return
    api.canvas(canvasId).then(setCanvas, () => setCanvas(null))
    void useCatalog.getState().load()
  }, [canvasId])

  const rename = async () => {
    if (!canvas) return
    const title = prompt('画布名称', canvas.title)?.trim()
    if (title && title !== canvas.title) setCanvas(await api.renameCanvas(canvas.id, title))
  }

  return (
    <div className="relative h-full w-full">
      <CanvasView source={source} />
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-4 p-4">
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl bg-surface/80 p-1 text-sm shadow-[var(--shadow-2)] backdrop-blur-xl">
          <a href="#/" className="rounded-lg px-2 py-1 font-medium tracking-wide hover:bg-white/5">
            Plein
          </a>
          <span className="text-ink-muted">/</span>
          <button
            type="button"
            onClick={rename}
            className="max-w-60 truncate rounded-lg px-2 py-1 hover:bg-white/5"
          >
            {source.kind === 'demo' ? `演示（${source.count} 个元素）` : (canvas?.title ?? '…')}
          </button>
          <span
            className={`px-2 text-xs ${sync === 'disconnected' ? 'text-amber-400' : 'text-ink-muted'}`}
            data-testid="sync-status"
          >
            {SYNC_LABELS[sync]}
          </span>
          {source.kind === 'remote' && (
            <button
              type="button"
              onClick={() => setSettings(true)}
              className="rounded-lg px-2 py-1 text-ink-muted hover:bg-white/5 hover:text-ink"
            >
              设置
            </button>
          )}
        </div>
        <p className="hidden text-xs text-ink-muted lg:block">
          {selection > 0 ? `已选 ${selection} 个 · ` : ''}拖入文件导入 · 双击编辑 / 播放 ·
          空格拖动平移 · ⌘+滚轮缩放 · ⌘Z 撤销
        </p>
      </header>
      {(importing || notice) && (
        <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center px-4">
          <div className="rounded-lg bg-surface/90 px-3 py-1.5 text-sm shadow-[var(--shadow-2)] backdrop-blur-xl">
            {importing ? `正在导入 ${importing.done}/${importing.total}…` : notice}
          </div>
        </div>
      )}
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4">
        <Toolbar canImport={source.kind === 'remote'} />
      </footer>
    </div>
  )
}

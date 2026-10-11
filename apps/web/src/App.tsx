import { CanvasView } from './canvas/CanvasView'
import { Toolbar } from './panels/Toolbar'
import { useCanvas } from './stores/canvas'

export function App() {
  const selection = useCanvas((s) => s.selection)
  return (
    <div className="relative h-full w-full">
      <CanvasView />
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4">
        <div className="pointer-events-auto rounded-xl bg-surface/80 px-3 py-1.5 text-sm font-medium tracking-wide shadow-[var(--shadow-2)] backdrop-blur-xl">
          Plein
        </div>
        <p className="text-xs text-ink-muted">
          {selection > 0 ? `已选 ${selection} 个 · ` : ''}拖拽框选 · 空格拖动平移 · 捏合 /
          ⌘+滚轮缩放 · ⌘C/⌘V 复制粘贴 · ⌘D 复制一份 · ⌘Z 撤销
        </p>
      </header>
      <footer className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4">
        <Toolbar />
      </footer>
    </div>
  )
}

import { CanvasView } from './canvas/CanvasView'

export function App() {
  return (
    <div className="relative h-full w-full">
      <CanvasView />
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between p-4">
        <div className="pointer-events-auto rounded-xl bg-surface/80 px-3 py-1.5 text-sm font-medium tracking-wide shadow-[var(--shadow-2)] backdrop-blur-xl">
          Plein
        </div>
        <p className="text-xs text-ink-muted">双指滑动平移 · 捏合 / ⌘+滚轮缩放 · 空格+拖拽 · 拖端口连线 · 拖卡片移动</p>
      </header>
    </div>
  )
}

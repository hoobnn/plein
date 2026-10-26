import { lazy, Suspense } from 'react'
import type { Engine } from '@plein/canvas-core'
import type { CanvasElement } from '@plein/doc'
import { useCanvas } from '../../stores/canvas'
import { useFollow } from '../../canvas/hooks'
import { Presence } from '../../ui/Presence'

export type AiAnalysisTarget =
  | { kind: 'local'; nodeId: string; resultId: string }
  | { kind: 'node'; nodeId: string }
const Panel = lazy(() =>
  import('./AiAnalysisPanel').then((module) => ({ default: module.AiAnalysisPanel })),
)
export function AiAnalysisEditor() {
  const engine = useCanvas((state) => state.engine)
  const target = useCanvas((state) => state.aiAnalysis)
  return (
    <Presence>
      {engine && target && (
        <Suspense fallback={null}>
          <Panel
            key={`${engine.doc.ydoc.guid}:${JSON.stringify(target)}`}
            engine={engine}
            target={target}
            onClose={() => useCanvas.getState().openAiAnalysis(null)}
          />
        </Suspense>
      )}
    </Presence>
  )
}
export function AiAnalysisEntry({ engine, el }: { engine: Engine; el: CanvasElement }) {
  const place = () => {
    const rect = engine.doc.worldRect(el.id)
    if (!rect) return null
    const at = engine.worldToClient(rect.x + rect.w / 2, rect.y + rect.h)
    return {
      left: Math.max(12, Math.min(window.innerWidth - 240, at.x - 110)),
      top: Math.max(80, Math.min(window.innerHeight - 150, at.y + 12)),
    }
  }
  const ref = useFollow<HTMLDivElement>(engine, place)
  const style = place()
  return (
    style && (
      <div ref={ref} style={style} className="ui-bar fixed z-30">
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          onClick={() => useCanvas.getState().openAiAnalysis({ kind: 'node', nodeId: el.id })}
        >
          查看 AI 分析与预检
        </button>
      </div>
    )
  )
}

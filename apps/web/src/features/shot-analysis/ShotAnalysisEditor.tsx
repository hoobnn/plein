import { lazy, Suspense } from 'react'
import { useCanvas } from '../../stores/canvas'
import { AnimatePresence } from '../../ui/motion'

const Panel = lazy(() =>
  import('./ShotAnalysisPanel').then((module) => ({ default: module.ShotAnalysisPanel })),
)

export function ShotAnalysisEditor() {
  const engine = useCanvas((state) => state.engine)
  const id = useCanvas((state) => state.shotAnalysis)
  return (
    <AnimatePresence>
      {engine && id && (
        <Suspense fallback={null}>
          <Panel
            key={`${engine.doc.ydoc.guid}:${id}`}
            engine={engine}
            id={id}
            onClose={() => useCanvas.getState().openShotAnalysis(null)}
          />
        </Suspense>
      )}
    </AnimatePresence>
  )
}

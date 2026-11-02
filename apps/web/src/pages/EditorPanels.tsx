import { lazy } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCanvas } from '../stores/canvas'
import { DeferredPanel } from '../ui/DeferredPanel'
import { LoadingPanel } from '../ui/LoadingPanel'

const StoryboardEditor = lazy(() =>
  import('../features/storyboard/StoryboardEditor').then((m) => ({ default: m.StoryboardEditor })),
)
const ScenePrep = lazy(() =>
  import('../features/scene-prep/ScenePrep').then((m) => ({ default: m.ScenePrep })),
)
const ShotWorkbench = lazy(() =>
  import('../features/storyboard/ShotWorkbench').then((m) => ({ default: m.ShotWorkbench })),
)
const SequenceEditor = lazy(() =>
  import('../features/sequence/SequenceEditor').then((m) => ({ default: m.SequenceEditor })),
)

export function EditorPanels() {
  const { storyboard, scenePrep, shotWorkbench, sequence } = useCanvas(
    useShallow((s) => ({
      storyboard: !!s.storyboard,
      scenePrep: !!s.scenePrep,
      shotWorkbench: !!s.shotWorkbench,
      sequence: !!s.sequence,
    })),
  )
  return (
    <>
      <DeferredPanel
        active={storyboard}
        fallback={storyboard ? <LoadingPanel label="正在打开分镜表…" /> : null}
      >
        <StoryboardEditor />
      </DeferredPanel>
      <DeferredPanel
        active={scenePrep}
        fallback={scenePrep ? <LoadingPanel label="正在打开场景准备…" /> : null}
      >
        <ScenePrep />
      </DeferredPanel>
      <DeferredPanel
        active={shotWorkbench}
        fallback={shotWorkbench ? <LoadingPanel label="正在打开镜头工作台…" /> : null}
      >
        <ShotWorkbench />
      </DeferredPanel>
      <DeferredPanel
        active={sequence}
        fallback={sequence ? <LoadingPanel label="正在打开序列…" /> : null}
      >
        <SequenceEditor />
      </DeferredPanel>
    </>
  )
}

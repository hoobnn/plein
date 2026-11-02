import { useShallow } from 'zustand/react/shallow'
import { useCanvas } from '../stores/canvas'
import { DeferredPanel } from '../ui/DeferredPanel'
import { LoadingPanel } from '../ui/LoadingPanel'

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
        load={() =>
          import('../features/storyboard/StoryboardEditor').then((m) => m.StoryboardEditor)
        }
        props={{}}
        fallback={storyboard ? <LoadingPanel label="正在打开分镜表…" /> : null}
      />
      <DeferredPanel
        active={scenePrep}
        load={() => import('../features/scene-prep/ScenePrep').then((m) => m.ScenePrep)}
        props={{}}
        fallback={scenePrep ? <LoadingPanel label="正在打开场景准备…" /> : null}
      />
      <DeferredPanel
        active={shotWorkbench}
        load={() => import('../features/storyboard/ShotWorkbench').then((m) => m.ShotWorkbench)}
        props={{}}
        fallback={shotWorkbench ? <LoadingPanel label="正在打开镜头工作台…" /> : null}
      />
      <DeferredPanel
        active={sequence}
        load={() => import('../features/sequence/SequenceEditor').then((m) => m.SequenceEditor)}
        props={{}}
        fallback={sequence ? <LoadingPanel label="正在打开序列…" /> : null}
      />
    </>
  )
}

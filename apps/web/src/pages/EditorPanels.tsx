import { useShallow } from 'zustand/react/shallow'
import { closeSequenceEditor, useCanvas } from '../stores/canvas'
import { DeferredPanel } from '../ui/DeferredPanel'

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
        panel={{ name: '分镜表', onClose: () => useCanvas.getState().openStoryboard(null) }}
      />
      <DeferredPanel
        active={scenePrep}
        load={() => import('../features/scene-prep/ScenePrep').then((m) => m.ScenePrep)}
        props={{}}
        panel={{ name: '场景准备', onClose: () => useCanvas.getState().openScenePrep(null) }}
      />
      <DeferredPanel
        active={shotWorkbench}
        load={() => import('../features/storyboard/ShotWorkbench').then((m) => m.ShotWorkbench)}
        props={{}}
        panel={{ name: '镜头工作台', onClose: () => useCanvas.getState().openShotWorkbench(null) }}
      />
      <DeferredPanel
        active={sequence}
        load={() => import('../features/sequence/SequenceEditor').then((m) => m.SequenceEditor)}
        props={{}}
        panel={{
          name: '序列',
          onClose: () => {
            const { engine, sequence: id } = useCanvas.getState()
            closeSequenceEditor(engine, id)
          },
        }}
      />
    </>
  )
}

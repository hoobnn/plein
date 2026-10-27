import { lazy, type ReactNode, Suspense, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCanvas } from '../stores/canvas'

const StoryboardEditor = lazy(() =>
  import('../features/storyboard/StoryboardEditor').then((m) => ({ default: m.StoryboardEditor })),
)
const ShotWorkbench = lazy(() =>
  import('../features/storyboard/ShotWorkbench').then((m) => ({ default: m.ShotWorkbench })),
)
const SequenceEditor = lazy(() =>
  import('../features/sequence/SequenceEditor').then((m) => ({ default: m.SequenceEditor })),
)

/** 面板第一次打开才加载；之后保留宿主，让面板自己的 Presence 完成退场。 */
function DeferredPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const [opened, setOpened] = useState(active)
  if (active && !opened) setOpened(true)
  return active || opened ? <Suspense fallback={null}>{children}</Suspense> : null
}

export function EditorPanels() {
  const { storyboard, shotWorkbench, sequence } = useCanvas(
    useShallow((s) => ({
      storyboard: !!s.storyboard,
      shotWorkbench: !!s.shotWorkbench,
      sequence: !!s.sequence,
    })),
  )
  return (
    <>
      <DeferredPanel active={storyboard}>
        <StoryboardEditor />
      </DeferredPanel>
      <DeferredPanel active={shotWorkbench}>
        <ShotWorkbench />
      </DeferredPanel>
      <DeferredPanel active={sequence}>
        <SequenceEditor />
      </DeferredPanel>
    </>
  )
}

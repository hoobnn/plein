import type { DesktopOpenNode, DesktopSaved } from '@plein/protocol'
import { lazy, Suspense, useEffect, useState } from 'react'
import { desktop } from '../desktop'
import { navigate } from '../router'
import { switchMode, useCanvas } from '../stores/canvas'
import { DeferredPanel } from '../ui/DeferredPanel'
import { prefetchIdle } from '../ui/idle'

const DesktopUpdates = lazy(() =>
  import('./DesktopUpdates').then((m) => ({ default: m.DesktopUpdates })),
)
const DesktopSavedToast = lazy(() =>
  import('./DesktopSavedToast').then((m) => ({ default: m.DesktopSavedToast })),
)

/** 等画布和节点都加载好再定位，最多等这么久 */
const REVEAL_TIMEOUT_MS = 10_000

/** 打开画布并选中、定位到节点（点系统通知时） */
export function revealNode({ canvasId, nodeId }: DesktopOpenNode) {
  if (useCanvas.getState().canvasId !== canvasId) navigate({ name: 'canvas', id: canvasId })
  const deadline = Date.now() + REVEAL_TIMEOUT_MS
  const tick = () => {
    const { engine, canvasId: current, mode } = useCanvas.getState()
    if (engine && current === canvasId && engine.doc.has(nodeId)) {
      if (mode !== 'flow') switchMode('flow')
      engine.selection.set([nodeId])
      engine.zoomToFit([nodeId])
      return
    }
    if (Date.now() < deadline) setTimeout(tick, 100)
  }
  tick()
}

/** 桌面端主进程发来的事件：点通知定位节点、文件保存结果和应用更新。 */
export function DesktopEvents() {
  const [saved, setSaved] = useState<DesktopSaved | null>(null)
  useEffect(() => desktop?.onOpenNode(revealNode), [])
  useEffect(
    () =>
      desktop?.onSaved((s) => {
        if (s.state !== 'cancelled') setSaved(s)
      }),
    [],
  )
  useEffect(() => prefetchIdle([() => import('./DesktopSavedToast')]), [])
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(null), 6000)
    return () => clearTimeout(t)
  }, [saved])
  if (!desktop) return null

  return (
    <>
      <Suspense fallback={null}>
        <DesktopUpdates />
      </Suspense>
      <DeferredPanel active={!!saved}>
        <DesktopSavedToast
          saved={saved}
          showLabel={desktop.platform === 'darwin' ? '在访达中显示' : '在文件夹中显示'}
          onShow={(path) => void desktop?.showSavedFile(path)}
          onClose={() => setSaved(null)}
        />
      </DeferredPanel>
    </>
  )
}

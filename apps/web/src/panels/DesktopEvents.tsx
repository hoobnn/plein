import type { DesktopOpenNode, DesktopSaved } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { desktop } from '../desktop'
import { navigate } from '../router'
import { switchMode, useCanvas } from '../stores/canvas'
import { Presence } from '../ui/Presence'
import { Toast } from '../ui/Toast'

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

/** 桌面端主进程发来的事件：点通知定位节点、另存为结束后提示并可在访达中显示 */
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
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(null), 6000)
    return () => clearTimeout(t)
  }, [saved])
  if (!desktop) return null

  const path = saved?.savePath
  return (
    <Presence>
      {saved && (
        <Toast
          action={
            path && (
              <button
                type="button"
                className="ui-btn ui-btn-quiet ui-btn-sm"
                onClick={() => {
                  void desktop?.showSavedFile(path)
                  setSaved(null)
                }}
              >
                {desktop.platform === 'darwin' ? '在访达中显示' : '在文件夹中显示'}
              </button>
            )
          }
        >
          {saved.state === 'completed' ? `已保存「${saved.name}」` : `「${saved.name}」保存失败`}
        </Toast>
      )}
    </Presence>
  )
}

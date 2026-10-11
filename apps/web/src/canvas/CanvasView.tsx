import { useEffect, useRef } from 'react'
import { Engine } from '@plein/canvas-core'
import { connectPorts, createDoc, upsertElement } from '@plein/doc'

/** React 只负责挂载；相机与渲染完全脱离 React 渲染周期。 */
export function CanvasView() {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current!
    const doc = createDoc()

    // 演示数据：一些占位卡片
    for (let i = 0; i < 24; i++) {
      upsertElement(doc, {
        id: `demo-${i}`,
        kind: 'image',
        x: (i % 6) * 280,
        y: Math.floor(i / 6) * 220,
        w: 240,
        h: 180,
        ports: {
          inputs: [
            { id: 'prompt', label: '提示词', type: 'text' },
            { id: 'ref', label: '参考图', type: 'image' },
          ],
          outputs: [{ id: 'out', label: '输出', type: 'image' }],
        },
      })
    }
    // 演示连线：从输出端口拖到输入端口即可新建，拖走已连的输入端口可断开
    connectPorts(doc, ['demo-0', 'out'], ['demo-1', 'ref'])
    connectPorts(doc, ['demo-1', 'out'], ['demo-8', 'ref'])
    connectPorts(doc, ['demo-6', 'out'], ['demo-7', 'ref'])

    const engine = new Engine({ host, doc, overlay: overlayRef.current ?? undefined })
    // StrictMode 下 effect 会执行两次：init 未完成前不能 destroy
    let disposed = false
    let ready = false
    engine.init().then(() => {
      if (disposed) return engine.destroy()
      ready = true
      engine.camera.panBy(120, 120)
    })
    return () => {
      disposed = true
      if (ready) engine.destroy()
    }
  }, [])

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0 touch-none select-none" />
      {/* DOM 覆盖层：文本编辑、Prompt 输入、节点表单等，跟随相机变换 */}
      <div ref={overlayRef} className="pointer-events-none absolute left-0 top-0 origin-top-left" />
    </div>
  )
}

import { Engine } from '@plein/canvas-core'
import { createDoc } from '@plein/doc'
import { useEffect, useRef } from 'react'
import { useCanvas } from '../stores/canvas'
import { demoAssetUrls, seedDemo } from './demo'

/** React 只负责挂载；相机与渲染完全脱离 React 渲染周期。 */
export function CanvasView() {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const attach = useCanvas((s) => s.attach)

  useEffect(() => {
    const host = hostRef.current!
    const doc = createDoc()
    const n = Number(new URLSearchParams(location.search).get('n') ?? 1000)
    seedDemo(doc, Number.isFinite(n) ? n : 1000)
    const assets = demoAssetUrls()

    const engine = new Engine({
      host,
      doc,
      overlay: overlayRef.current ?? undefined,
      assetUrl: (id) => assets.get(id),
    })
    // StrictMode 下 effect 会执行两次：init 未完成前不能 destroy
    let disposed = false
    let detach: (() => void) | null = null
    engine.init().then(() => {
      if (disposed) return engine.destroy()
      detach = attach(engine)
      engine.zoomToFit()
      if (import.meta.env.DEV) Object.assign(window, { plein: engine })
    })
    return () => {
      disposed = true
      if (detach) {
        detach()
        engine.destroy()
      }
      doc.destroy()
    }
  }, [attach])

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0 touch-none select-none" />
      {/* DOM 覆盖层：文本编辑、Prompt 输入、节点表单等，跟随相机变换 */}
      <div ref={overlayRef} className="pointer-events-none absolute left-0 top-0 origin-top-left" />
    </div>
  )
}

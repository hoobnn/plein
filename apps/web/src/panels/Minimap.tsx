import type { Engine } from '@plein/canvas-core'
import { useEffect, useRef } from 'react'

const W = 180
const H = 116
const PAD = 8

/** 当前主题下的令牌颜色（随明暗切换重新读取） */
function tokens() {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    node: v('--ink-subtle'),
    frame: v('--line-strong'),
    view: v('--accent'),
    viewFill: v('--accent-soft'),
  }
}

/**
 * 小地图：顶层元素的缩略分布 + 当前视口框；
 * 点击或拖动把视口中心移过去。只在相机或文档变化时按帧重画。
 */
export function Minimap({ engine }: { engine: Engine }) {
  const ref = useRef<HTMLCanvasElement>(null)
  /** 小地图坐标 -> 世界坐标的映射，交互时用 */
  const map = useRef({ x: 0, y: 0, k: 1 })

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')!
    let frame = 0

    const draw = () => {
      frame = 0
      const { scene, camera } = engine
      const view = camera.viewRect
      const content = engine.contentBounds()
      // 取内容与视口的并集，留出边距，等比放进小地图
      const x0 = Math.min(view.x, content?.x ?? view.x)
      const y0 = Math.min(view.y, content?.y ?? view.y)
      const x1 = Math.max(view.x + view.w, content ? content.x + content.w : view.x + view.w)
      const y1 = Math.max(view.y + view.h, content ? content.y + content.h : view.y + view.h)
      const k = Math.min((W - PAD * 2) / (x1 - x0), (H - PAD * 2) / (y1 - y0))
      const ox = PAD + (W - PAD * 2 - (x1 - x0) * k) / 2 - x0 * k
      const oy = PAD + (H - PAD * 2 - (y1 - y0) * k) / 2 - y0 * k
      map.current = { x: ox, y: oy, k }

      const t = tokens()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      for (const id of scene.children(null)) {
        const el = scene.get(id)
        const r = scene.rect(id)
        if (!el || !r) continue
        const rx = ox + r.x * k
        const ry = oy + r.y * k
        const rw = Math.max(r.w * k, 1.5)
        const rh = Math.max(r.h * k, 1.5)
        if (el.kind === 'frame') {
          ctx.strokeStyle = el.color ?? t.frame
          ctx.lineWidth = 1
          ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1)
          for (const cid of scene.children(id)) {
            const c = scene.rect(cid)
            if (!c) continue
            ctx.globalAlpha = 0.55
            ctx.fillStyle = t.node
            ctx.fillRect(ox + c.x * k, oy + c.y * k, Math.max(c.w * k, 1), Math.max(c.h * k, 1))
            ctx.globalAlpha = 1
          }
        } else {
          ctx.globalAlpha = 0.55
          ctx.fillStyle = t.node
          ctx.fillRect(rx, ry, rw, rh)
          ctx.globalAlpha = 1
        }
      }
      // 视口框
      ctx.fillStyle = t.viewFill
      ctx.strokeStyle = t.view
      ctx.lineWidth = 1.5
      const vx = ox + view.x * k
      const vy = oy + view.y * k
      ctx.fillRect(vx, vy, view.w * k, view.h * k)
      ctx.strokeRect(vx, vy, view.w * k, view.h * k)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    draw()
    const offCamera = engine.camera.onChange(schedule)
    const offDoc = engine.doc.subscribe(schedule)
    const theme = new MutationObserver(schedule)
    theme.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    return () => {
      offCamera()
      offDoc()
      theme.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [engine])

  const jump = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const m = map.current
    engine.camera.centerOn((e.clientX - r.left - m.x) / m.k, (e.clientY - r.top - m.y) / m.k)
  }

  return (
    <div className="ui-float pointer-events-auto overflow-hidden rounded-lg p-1">
      <canvas
        ref={ref}
        aria-label="小地图：点击或拖动移动视口"
        style={{ width: W, height: H }}
        className="block cursor-pointer rounded-md bg-canvas"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          jump(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) jump(e)
        }}
      />
    </div>
  )
}

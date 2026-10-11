import { Graphics } from 'pixi.js'
import type { PleinDoc } from '@plein/doc'
import type { Camera } from './camera'
import { PORT_COLORS, PORT_RADIUS, eachPort, findPort, type PortRef } from './ports'

const EDGE_COLOR = 0xe8d5b5

/** 拖拽中的连线预览：从一个端口拉到光标 */
export interface EdgePreview {
  from: PortRef
  x: number
  y: number
  /** 光标吸附到的可连端口 */
  target: PortRef | null
}

/**
 * 连线与端口图层。
 * - edges：画在节点下方
 * - ports：画在节点上方，含拖拽预览
 * 文档或相机变化只标脏，统一在 ticker 里重画（每帧最多一次）。
 */
export class EdgeLayer {
  readonly edges = new Graphics()
  readonly ports = new Graphics()
  private dirty = true
  private preview: EdgePreview | null = null
  private hover: PortRef | null = null
  private disposers: Array<() => void> = []

  constructor(
    private doc: PleinDoc,
    private camera: Camera,
  ) {
    this.edges.zIndex = -1
    this.ports.zIndex = 1
    const mark = () => this.markDirty()
    doc.elements.observe(mark)
    doc.edges.observe(mark)
    this.disposers.push(
      () => doc.elements.unobserve(mark),
      () => doc.edges.unobserve(mark),
      camera.onChange(mark),
    )
  }

  markDirty() {
    this.dirty = true
  }

  setPreview(p: EdgePreview | null) {
    this.preview = p
    this.markDirty()
  }

  setHover(p: PortRef | null) {
    if (p?.elementId === this.hover?.elementId && p?.port.id === this.hover?.port.id) return
    this.hover = p
    this.markDirty()
  }

  update() {
    if (!this.dirty) return
    this.dirty = false
    // 线宽按缩放反算，屏幕上保持恒定粗细
    const px = 1 / this.camera.zoom
    const { elements, edges } = this.doc

    const g = this.edges.clear()
    for (const e of edges.values()) {
      const a = elements.get(e.from[0])
      const b = elements.get(e.to[0])
      const from = a && findPort(a, e.from[1], 'out')
      const to = b && findPort(b, e.to[1], 'in')
      if (!from || !to) continue
      bezier(g, from.x, from.y, to.x, to.y)
      g.stroke({ color: EDGE_COLOR, alpha: 0.7, width: 2 * px })
    }

    const p = this.ports.clear()
    if (this.preview) {
      const { from, target } = this.preview
      const end = target ?? this.preview
      if (from.side === 'out') bezier(p, from.x, from.y, end.x, end.y)
      else bezier(p, end.x, end.y, from.x, from.y)
      p.stroke({ color: EDGE_COLOR, alpha: target ? 0.9 : 0.5, width: 2 * px })
    }
    const active = this.preview?.target ?? this.hover
    for (const el of elements.values()) {
      eachPort(el, (ref) => {
        const on = active?.elementId === ref.elementId && active.port.id === ref.port.id
        p.circle(ref.x, ref.y, on ? PORT_RADIUS * 1.4 : PORT_RADIUS)
          .fill({ color: 0x0e0e10 })
          .stroke({ color: PORT_COLORS[ref.port.type], width: 2 * px })
      })
    }
  }

  destroy() {
    this.disposers.forEach((d) => d())
    this.edges.destroy()
    this.ports.destroy()
  }
}

/** 水平出入的三次贝塞尔：输出向右伸出，输入从左进入 */
function bezier(g: Graphics, x1: number, y1: number, x2: number, y2: number) {
  const c = Math.max(40, Math.abs(x2 - x1) * 0.5)
  g.moveTo(x1, y1).bezierCurveTo(x1 + c, y1, x2 - c, y2, x2, y2)
}

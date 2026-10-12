import { type CanvasElement, elementPorts } from '@plein/doc'
import { Graphics } from 'pixi.js'
import type { Camera } from './camera'
import { eachHandle, findPort, PORT_RADIUS, type PortRef, portColor } from './ports'
import type { Scene } from './scene'
import type { Selection } from './selection'
import { theme } from './theme'

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
 * - ports：画在节点上方，含拖拽预览；只画视口内元素的端口
 * 位置取自场景（含拖拽预览），变化只标脏，统一在 ticker 里重画。
 */
export class EdgeLayer {
  readonly edges = new Graphics()
  readonly ports = new Graphics()
  private dirty = true
  private preview: EdgePreview | null = null
  private hover: PortRef | null = null
  /** 光标所在（或贴近）的元素：它的端口显示出来 */
  private hoverEl: string | null = null
  /** 隐藏连线：只画连着选中 / 悬停元素的线，画布密时看得清卡片 */
  private hidden = false

  constructor(
    private scene: Scene,
    private camera: Camera,
    private selection: Selection,
  ) {
    this.edges.zIndex = -1
    this.ports.zIndex = 1
  }

  markDirty() {
    this.dirty = true
  }

  setPreview(p: EdgePreview | null) {
    this.preview = p
    this.markDirty()
  }

  setHover(p: PortRef | null) {
    if (p?.elementId === this.hover?.elementId && p?.side === this.hover?.side) return
    this.hover = p
    this.markDirty()
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden
    this.markDirty()
  }

  setHoverElement(id: string | null) {
    if (id === this.hoverEl) return
    this.hoverEl = id
    this.markDirty()
  }

  /**
   * 端口是否显示（也决定能否点中）：只在悬停、选中或正在连线时显示，
   * 平时卡片保持干净，连线直接接在卡片边缘。
   */
  portsVisible(el: CanvasElement) {
    if (!elementPorts(el)) return false
    return this.preview !== null || this.selection.has(el.id) || this.hoverEl === el.id
  }

  /** 世界坐标下的端口 */
  port(elementId: string, portId: string, side: 'in' | 'out') {
    const el = this.scene.get(elementId)
    const r = this.scene.rect(elementId)
    return el && r ? findPort(el, r, portId, side) : null
  }

  update() {
    if (!this.dirty) return
    this.dirty = false
    // 线宽按缩放反算，屏幕上保持恒定粗细
    const px = 1 / this.camera.zoom
    const now = performance.now()
    let animating = false

    const g = this.edges.clear()
    const connected = new Set<string>()
    for (const e of this.scene.doc.edges()) {
      const from = this.port(e.from[0], e.from[1], 'out')
      const to = this.port(e.to[0], e.to[1], 'in')
      if (!from || !to) continue
      connected.add(`${e.from[0]}:out`)
      connected.add(`${e.to[0]}:in`)
      // 按数据类型着色；连着选中元素的线加重
      const on = this.selection.has(e.from[0]) || this.selection.has(e.to[0])
      const status = this.scene.get(e.to[0])?.run?.status
      const running = status === 'running' || status === 'queued'
      if (this.hidden && !on && !running && this.hoverEl !== e.from[0] && this.hoverEl !== e.to[0])
        continue
      const color = portColor(from.port.type)
      if (running) {
        // 下游正在生成：沿连线流动的虚线，示意数据正在流过去
        animating = true
        bezier(g, from.x, from.y, to.x, to.y)
        g.stroke({ color, alpha: 0.18, width: 2 * px })
        dashedBezier(g, from.x, from.y, to.x, to.y, 8 * px, 6 * px, (now / 40) * px)
        g.stroke({ color: theme.accent, alpha: 0.95, width: 2 * px })
        continue
      }
      bezier(g, from.x, from.y, to.x, to.y)
      g.stroke({ color, alpha: on ? 0.95 : 0.45, width: (on ? 2 : 1.5) * px })
    }

    const p = this.ports.clear()
    if (this.preview) {
      const { from, target } = this.preview
      const end = target ?? this.preview
      if (from.side === 'out') bezier(p, from.x, from.y, end.x, end.y)
      else bezier(p, end.x, end.y, from.x, from.y)
      p.stroke({ color: portColor(from.port.type), alpha: target ? 0.95 : 0.6, width: 2 * px })
    }
    if (animating) this.dirty = true
    // 缩得很小时端口点太密，不画
    if (this.camera.zoom < 0.25) return
    const active = this.preview?.target ?? this.hover
    for (const id of this.scene.query(this.camera.viewRect)) {
      const el = this.scene.get(id)
      const r = this.scene.rect(id)
      if (!el || !r || !this.portsVisible(el)) continue
      eachHandle(el, r, (side, ports, at) => {
        const on = active?.elementId === el.id && active.side === side
        // 一侧的端口类型都一样时按类型着色，混着的用中性色
        const types = new Set(ports.map((p) => p.type))
        const color = types.size === 1 ? portColor(ports[0]!.type) : portColor('any')
        // 屏幕上保持约 9px 的圆，缩小后也点得中
        const rad = Math.max(PORT_RADIUS, 9 * px) * (on ? 1.25 : 1)
        p.circle(at.x, at.y, rad)
          .fill({ color: theme.knob })
          .stroke({ color, width: 1.5 * px })
        // 没连线的一侧画“+”：从这里拉出可以新建并连上节点
        if (!connected.has(`${el.id}:${side}`)) {
          const a = rad * 0.45
          p.moveTo(at.x - a, at.y)
            .lineTo(at.x + a, at.y)
            .moveTo(at.x, at.y - a)
            .lineTo(at.x, at.y + a)
            .stroke({ color, width: 1.5 * px })
        } else {
          p.circle(at.x, at.y, rad * 0.4).fill({ color })
        }
      })
    }
  }

  destroy() {
    this.edges.destroy()
    this.ports.destroy()
  }
}

/** 水平出入的三次贝塞尔：输出向右伸出，输入从左进入 */
function bezier(g: Graphics, x1: number, y1: number, x2: number, y2: number) {
  const c = Math.max(40, Math.abs(x2 - x1) * 0.5)
  g.moveTo(x1, y1).bezierCurveTo(x1 + c, y1, x2 - c, y2, x2, y2)
}

/** 三次贝塞尔上的点 */
function bezierPoint(x1: number, y1: number, x2: number, y2: number, t: number) {
  const c = Math.max(40, Math.abs(x2 - x1) * 0.5)
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const d = 3 * u * t * t
  const e = t * t * t
  return {
    x: a * x1 + b * (x1 + c) + d * (x2 - c) + e * x2,
    y: a * y1 + b * y1 + d * y2 + e * y2,
  }
}

/** 沿贝塞尔的虚线，offset 随时间增长即向下游流动 */
function dashedBezier(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dash: number,
  gap: number,
  offset: number,
) {
  // 分段足够细，每段不超过半个虚线长
  const rough = Math.hypot(x2 - x1, y2 - y1) * 1.4 + 80
  const steps = Math.min(400, Math.max(16, Math.ceil(rough / (dash / 2))))
  const pts = Array.from({ length: steps + 1 }, (_, i) => bezierPoint(x1, y1, x2, y2, i / steps))
  const period = dash + gap
  let dist = -(offset % period)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    // 线段起点落在“实”的那一段就画
    const phase = ((dist % period) + period) % period
    if (phase < dash) g.moveTo(a.x, a.y).lineTo(b.x, b.y)
    dist += len
  }
}

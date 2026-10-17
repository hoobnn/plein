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
  /** 下游正在生成的连线上流动的虚线：单独一层，每帧只重画这几条 */
  readonly flow = new Graphics()
  readonly ports = new Graphics()
  private dirty = true
  /** 只有端口层要重画（悬停变化）：连线不动 */
  private portsDirty = true
  /** 正在流动的连线（世界坐标端点），静态层重画时收集 */
  private running: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
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
    this.flow.zIndex = -1
    this.ports.zIndex = 1
  }

  markDirty() {
    this.dirty = true
  }

  /** 只平移：连线在世界坐标里不变；正在拉线时端口要按新视口重画 */
  cameraMoved() {
    if (this.preview) this.portsDirty = true
  }

  setPreview(p: EdgePreview | null) {
    this.preview = p
    this.markDirty()
  }

  setHover(p: PortRef | null) {
    if (p?.elementId === this.hover?.elementId && p?.side === this.hover?.side) return
    this.hover = p
    this.portsDirty = true
  }

  setHidden(hidden: boolean) {
    this.hidden = hidden
    this.markDirty()
  }

  setHoverElement(id: string | null) {
    if (id === this.hoverEl) return
    this.hoverEl = id
    // 悬停只影响端口；隐藏连线模式下悬停元素的线才露出来，要整层重画
    if (this.hidden) this.markDirty()
    else this.portsDirty = true
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

  /** 需要时重画；返回这一帧是否改了图形（引擎据此决定要不要渲染） */
  update(): boolean {
    let changed = false
    if (this.dirty) {
      this.dirty = false
      this.portsDirty = false
      this.drawEdges()
      this.drawPorts()
      changed = true
    } else if (this.portsDirty) {
      this.portsDirty = false
      this.drawPorts()
      changed = true
    }
    return this.drawFlow() || changed
  }

  private drawEdges() {
    // 线宽按缩放反算，屏幕上保持恒定粗细
    const px = 1 / this.camera.zoom
    const g = this.edges.clear()
    this.running = []
    this.connected.clear()
    for (const e of this.scene.doc.edges()) {
      const from = this.port(e.from[0], e.from[1], 'out')
      const to = this.port(e.to[0], e.to[1], 'in')
      if (!from || !to) continue
      this.connected.add(`${e.from[0]}:out`)
      this.connected.add(`${e.to[0]}:in`)
      // 按数据类型着色；连着选中元素的线加重
      const on = this.selection.has(e.from[0]) || this.selection.has(e.to[0])
      const status = this.scene.get(e.to[0])?.run?.status
      const running = status === 'running' || status === 'queued'
      if (this.hidden && !on && !running && this.hoverEl !== e.from[0] && this.hoverEl !== e.to[0])
        continue
      const color = portColor(from.port.type)
      bezier(g, from.x, from.y, to.x, to.y)
      if (running) {
        // 下游正在生成：淡底线 + 流动的虚线（虚线在 flow 层逐帧画）
        g.stroke({ color, alpha: 0.18, width: 2 * px })
        this.running.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })
        continue
      }
      g.stroke({ color, alpha: on ? 0.95 : 0.45, width: (on ? 2 : 1.5) * px })
    }
  }

  /** 端口上已连线的一侧（画“+”还是实心点） */
  private connected = new Set<string>()

  private drawPorts() {
    const px = 1 / this.camera.zoom
    const p = this.ports.clear()
    if (this.preview) {
      const { from, target } = this.preview
      const end = target ?? this.preview
      if (from.side === 'out') bezier(p, from.x, from.y, end.x, end.y)
      else bezier(p, end.x, end.y, from.x, from.y)
      p.stroke({ color: portColor(from.port.type), alpha: target ? 0.95 : 0.6, width: 2 * px })
    }
    // 缩得很小时端口点太密，不画
    if (this.camera.zoom < 0.25) return
    const active = this.preview?.target ?? this.hover
    // 平时只有选中和悬停的元素露出端口；拉线时视口内都露出
    const candidates = this.preview
      ? this.scene.query(this.camera.viewRect)
      : [...this.selection.values(), ...(this.hoverEl ? [this.hoverEl] : [])]
    for (const id of new Set(candidates)) {
      const el = this.scene.get(id)
      const r = this.scene.rect(id)
      if (!el || !r || !this.portsVisible(el)) continue
      eachHandle(el, r, (side, ports, at) => {
        const front = this.scene.hitTest(
          at.x,
          at.y,
          (other) => this.scene.get(other)?.kind !== 'frame',
        )
        if (front && front !== id && this.scene.drawOrder(front) > this.scene.drawOrder(id)) return
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
        if (!this.connected.has(`${el.id}:${side}`)) {
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

  /** 流动虚线：只要有下游在生成就逐帧推进；视口外的不画 */
  private drawFlow(): boolean {
    const f = this.flow
    const px = 1 / this.camera.zoom
    const offset = (performance.now() / 40) * px
    const v = this.camera.viewRect
    let drawn = 0
    if (this.running.length > 0) f.clear()
    for (const { x1, y1, x2, y2 } of this.running) {
      const c = Math.max(40, Math.abs(x2 - x1) * 0.5)
      if (
        Math.max(x1, x2) + c < v.x ||
        Math.min(x1, x2) - c > v.x + v.w ||
        Math.max(y1, y2) < v.y ||
        Math.min(y1, y2) > v.y + v.h
      )
        continue
      dashedBezier(f, x1, y1, x2, y2, 8 * px, 6 * px, offset)
      drawn++
    }
    // 没有可见的流动线：清掉一次后不再触发渲染
    if (drawn === 0) {
      if (!f.visible) return false
      f.clear().visible = false
      return true
    }
    f.visible = true
    f.stroke({ color: theme.accent, alpha: 0.95, width: 2 * px })
    return true
  }

  destroy() {
    this.edges.destroy()
    this.flow.destroy()
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

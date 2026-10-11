import { Application, Container, Graphics } from 'pixi.js'
import type { YMapEvent } from 'yjs'
import type { CanvasElement, PleinDoc } from '@plein/doc'
import { Camera } from './camera'
import { attachInput } from './input'
import { EdgeLayer } from './edges'
import { attachInteractions } from './interact'

export interface EngineOptions {
  host: HTMLElement
  doc: PleinDoc
  /** DOM 覆盖层，跟随相机变换 */
  overlay?: HTMLElement
  background?: number
}

/**
 * 画布引擎：GPU 渲染（WebGPU 优先，回退 WebGL）+ DOM 覆盖层。
 * 当前为最小骨架：点阵网格 + 元素占位矩形 + 相机/输入。
 */
export class Engine {
  readonly camera = new Camera()
  private app = new Application()
  private world = new Container()
  private grid = new Graphics()
  private nodes = new Map<string, Graphics>()
  private edgeLayer: EdgeLayer
  private disposers: Array<() => void> = []

  constructor(private opts: EngineOptions) {
    this.edgeLayer = new EdgeLayer(opts.doc, this.camera)
  }

  async init() {
    const { host, background = 0x0e0e10 } = this.opts
    await this.app.init({
      resizeTo: host,
      background,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio,
      preference: 'webgpu',
    })
    host.appendChild(this.app.canvas)
    this.app.stage.addChild(this.grid, this.world)
    // 连线在节点下、端口在节点上，靠 zIndex 排序
    this.world.sortableChildren = true
    this.world.addChild(this.edgeLayer.edges, this.edgeLayer.ports)
    this.app.ticker.add(() => this.edgeLayer.update())

    this.disposers.push(attachInput(host, this.camera))
    this.disposers.push(attachInteractions(host, this.camera, this.opts.doc, this.edgeLayer))
    this.disposers.push(this.camera.onChange(() => this.syncCamera()))

    // 订阅文档变更，做增量更新
    const { elements } = this.opts.doc
    elements.forEach((el) => this.upsertNode(el))
    const observer = (e: YMapEvent<CanvasElement>) => {
      e.keysChanged.forEach((id) => {
        const el = elements.get(id)
        if (el) this.upsertNode(el)
        else this.removeNode(id)
      })
    }
    elements.observe(observer)
    this.disposers.push(() => elements.unobserve(observer))

    const onResize = () => this.drawGrid()
    this.app.renderer.on('resize', onResize)
    this.disposers.push(() => this.app.renderer.off('resize', onResize))

    this.syncCamera()
  }

  private syncCamera() {
    const { x, y, zoom } = this.camera
    this.world.position.set(x, y)
    this.world.scale.set(zoom)
    if (this.opts.overlay) this.opts.overlay.style.transform = this.camera.cssTransform
    this.drawGrid()
  }

  /** 屏幕空间点阵：间距随缩放分级，避免过密 */
  private drawGrid() {
    const { width, height } = this.app.screen
    const { x, y, zoom } = this.camera
    let step = 24 * zoom
    while (step < 12) step *= 4
    while (step > 96) step /= 4
    const ox = ((x % step) + step) % step
    const oy = ((y % step) + step) % step
    const g = this.grid.clear()
    for (let gx = ox; gx < width; gx += step) {
      for (let gy = oy; gy < height; gy += step) {
        g.circle(gx, gy, 0.9)
      }
    }
    g.fill({ color: 0xffffff, alpha: 0.08 })
  }

  private upsertNode(el: CanvasElement) {
    let g = this.nodes.get(el.id)
    if (!g) {
      g = new Graphics()
      this.nodes.set(el.id, g)
      this.world.addChild(g)
    }
    g.clear()
      .roundRect(0, 0, el.w, el.h, 14)
      .fill({ color: 0x1b1b1f })
      .stroke({ color: 0xffffff, alpha: 0.08, width: 1 })
    g.position.set(el.x, el.y)
  }

  private removeNode(id: string) {
    this.nodes.get(id)?.destroy()
    this.nodes.delete(id)
  }

  destroy() {
    this.disposers.forEach((d) => d())
    this.edgeLayer.destroy()
    this.app.destroy(true, { children: true })
  }
}

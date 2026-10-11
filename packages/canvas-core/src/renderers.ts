import type { CanvasElement, ElementKind } from '@plein/doc'
import { Assets, Container, Graphics, Text, type Texture } from 'pixi.js'

export interface RenderContext {
  /** assetId → 可加载的 URL；M2 由资产服务提供 */
  assetUrl?: (assetId: string) => string | undefined
}

/** 渲染器产出的显示对象，按元素局部坐标 (0,0)-(w,h) 绘制 */
export interface ElementView {
  display: Container
  update(el: CanvasElement): void
  /** 细节层级：缩得很小时隐藏文字等细节，减少绘制开销 */
  setDetail?(high: boolean): void
  destroy(): void
}

export type ElementRenderer = (el: CanvasElement, ctx: RenderContext) => ElementView

const RADIUS = 14
const SURFACE = 0x1b1b1f
const LINE = 0xffffff

const KIND_LABELS: Record<ElementKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  markdown: 'Markdown',
  node: '节点',
  frame: 'Frame',
  sequence: '序列',
}

const KIND_ACCENTS: Record<ElementKind, number> = {
  image: 0x7cc4ff,
  video: 0xc59bff,
  audio: 0x8be0a4,
  markdown: 0xe8d5b5,
  node: 0xf2b880,
  frame: 0xb4b4bc,
  sequence: 0xff9fb2,
}

const labelStyle = {
  fontFamily: 'Inter, PingFang SC, system-ui, sans-serif',
  fontSize: 13,
  fill: 0x8b8b93,
} as const

function titleOf(el: CanvasElement) {
  if (el.name) return el.name
  if (el.kind === 'markdown' && el.text) return el.text.split('\n')[0]!.replace(/^#+\s*/, '')
  if (el.kind === 'node' && el.nodeType) return el.nodeType
  return KIND_LABELS[el.kind]
}

/** 占位卡片：圆角底板 + 类型色条 + 标题；可选纹理铺底（图片） */
function card(el: CanvasElement, texture?: () => Texture | undefined): ElementView {
  const display = new Container()
  const bg = new Graphics()
  const label = new Text({ text: '', style: labelStyle, resolution: 2 })
  label.position.set(12, 10)
  display.addChild(bg, label)
  let high = true
  let current = el
  const view: ElementView = {
    display,
    update(next) {
      current = next
      const tex = texture?.()
      bg.clear().roundRect(0, 0, next.w, next.h, RADIUS)
      // 纹理按形状包围盒铺满（textureSpace: local），省掉昂贵的遮罩
      if (tex) bg.fill({ texture: tex, textureSpace: 'local' })
      else bg.fill({ color: SURFACE }).stroke({ color: LINE, alpha: 0.08, width: 1 })
      if (!tex && high) {
        bg.roundRect(12, next.h - 16, Math.min(40, next.w - 24), 3, 1.5).fill({
          color: KIND_ACCENTS[next.kind],
          alpha: 0.8,
        })
      }
      label.text = titleOf(next)
      label.visible = high && !tex && next.w > 60 && next.h > 36
    },
    setDetail(next) {
      if (next === high) return
      high = next
      view.update(current)
    },
    destroy: () => display.destroy({ children: true }),
  }
  view.update(el)
  return view
}

export const cardRenderer: ElementRenderer = (el) => card(el)

/** Frame：半透明底 + 边框，标题在框外左上 */
export const frameRenderer: ElementRenderer = (el) => {
  const display = new Container()
  const bg = new Graphics()
  const label = new Text({ text: '', style: { ...labelStyle, fontSize: 12 }, resolution: 2 })
  label.position.set(2, -20)
  display.addChild(bg, label)
  const view: ElementView = {
    display,
    update(next) {
      bg.clear()
        .roundRect(0, 0, next.w, next.h, 10)
        .fill({ color: 0xffffff, alpha: 0.035 })
        .stroke({ color: LINE, alpha: 0.16, width: 1.5 })
      label.text = titleOf(next)
    },
    setDetail(high) {
      label.visible = high
    },
    destroy: () => display.destroy({ children: true }),
  }
  view.update(el)
  return view
}

/** 图片：有可用 URL 时加载纹理铺满卡片，否则显示占位卡片 */
export const imageRenderer: ElementRenderer = (el, ctx) => {
  let texture: Texture | undefined
  let loading: string | undefined
  let destroyed = false
  let latest = el
  const view = card(el, () => texture)
  const update = view.update

  view.update = (next) => {
    latest = next
    update(next)
    const url = next.assetId ? ctx.assetUrl?.(next.assetId) : undefined
    if (!url || url === loading) return
    loading = url
    Assets.load<Texture>(url)
      .then((tex) => {
        if (destroyed || loading !== url) return
        texture = tex
        update(latest)
      })
      .catch(() => {
        // 加载失败保留占位卡片
      })
  }
  const destroy = view.destroy
  view.destroy = () => {
    destroyed = true
    destroy()
  }
  view.update(el)
  return view
}

/** 按元素类型注册渲染器；未注册的类型用占位卡片 */
export class RendererRegistry {
  private map = new Map<ElementKind, ElementRenderer>()

  constructor(defaults = true) {
    if (defaults) {
      this.register('frame', frameRenderer)
      this.register('image', imageRenderer)
    }
  }

  register(kind: ElementKind, renderer: ElementRenderer) {
    this.map.set(kind, renderer)
  }

  create(el: CanvasElement, ctx: RenderContext): ElementView {
    return (this.map.get(el.kind) ?? cardRenderer)(el, ctx)
  }
}

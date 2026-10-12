import { type CanvasElement, currentResult, type ElementKind } from '@plein/doc'
import { Assets, Container, Graphics, Text, type Texture } from 'pixi.js'
import { theme } from './theme'

export interface RenderContext {
  /** 资产在画布上的预览图 URL：图片缩略图、视频封面、音频波形 */
  assetUrl?: (assetId: string, kind: ElementKind) => string | undefined
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

const RADIUS = 16

const KIND_LABELS: Record<ElementKind, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  markdown: 'Markdown',
  node: '节点',
  frame: 'Frame',
  sequence: '序列',
}

const labelStyle = {
  fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
  fontSize: 13,
  fill: theme.label,
} as const

/** 卡片底板：填充 + 细描边 */
function plate(g: Graphics, w: number, h: number) {
  return g
    .roundRect(0, 0, w, h, RADIUS)
    .fill({ color: theme.surface })
    .stroke({ color: theme.line.color, alpha: theme.line.alpha, width: 1 })
}

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
      else
        bg.fill({ color: theme.surface }).stroke({
          color: theme.line.color,
          alpha: theme.line.alpha,
          width: 1,
        })
      if (!tex && high) {
        bg.roundRect(12, next.h - 16, Math.min(40, next.w - 24), 3, 1.5).fill({
          color: theme.kinds[next.kind],
          alpha: 0.8,
        })
      }
      label.style.fill = theme.label
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
  const label = new Text({
    text: '',
    style: { ...labelStyle, fontSize: 12, fontWeight: '500' },
    resolution: 2,
  })
  label.position.set(4, -22)
  display.addChild(bg, label)
  const view: ElementView = {
    display,
    update(next) {
      const f = theme.frame
      bg.clear()
        .roundRect(0, 0, next.w, next.h, 20)
        .fill({ color: f.fill, alpha: f.fillAlpha })
        .stroke({ color: f.line, alpha: f.lineAlpha, width: 1 })
      label.style.fill = theme.label
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

/** 加载预览纹理；URL 没有扩展名，显式指定解析器 */
function loadTexture(url: string) {
  return Assets.load<Texture>({ src: url, parser: 'texture' })
}

/**
 * 媒体元素：底板 + 预览纹理（图片缩略图 / 视频封面 / 音频波形）。
 * 纹理未加载或加载失败时显示占位卡片。
 */
export const mediaRenderer: ElementRenderer = (el, ctx) => {
  const display = new Container()
  const bg = new Graphics()
  const glyph = new Graphics()
  const label = new Text({ text: '', style: labelStyle, resolution: 2 })
  label.position.set(12, 10)
  display.addChild(bg, glyph, label)
  let texture: Texture | undefined
  let loading: string | undefined
  let destroyed = false
  let high = true
  let current = el

  const draw = (next: CanvasElement) => {
    const { w, h, kind } = next
    bg.clear().roundRect(0, 0, w, h, RADIUS).fill({ color: theme.surface })
    if (texture) {
      // 纹理按形状包围盒铺满（textureSpace: local），省掉昂贵的遮罩
      bg.roundRect(0, 0, w, h, RADIUS).fill({ texture, textureSpace: 'local' })
    } else {
      bg.stroke({ color: theme.line.color, alpha: theme.line.alpha, width: 1 })
      if (high)
        bg.roundRect(12, h - 16, Math.min(40, w - 24), 3, 1.5).fill({
          color: theme.kinds[kind],
          alpha: 0.8,
        })
    }
    glyph.clear()
    if (kind === 'video' && high && texture) {
      const r = Math.min(24, w / 6, h / 6)
      glyph
        .circle(w / 2, h / 2, r)
        .fill({ color: 0x000000, alpha: 0.45 })
        .poly([
          w / 2 - r * 0.35,
          h / 2 - r * 0.5,
          w / 2 - r * 0.35,
          h / 2 + r * 0.5,
          w / 2 + r * 0.55,
          h / 2,
        ])
        .fill({ color: 0xffffff, alpha: 0.9 })
    }
    label.style.fill = theme.label
    label.text = titleOf(next)
    // 图片、视频有了预览就不再显示标题；音频波形上方保留文件名
    label.visible = high && (!texture || kind === 'audio') && w > 60 && h > 36
  }

  const view: ElementView = {
    display,
    update(next) {
      current = next
      draw(next)
      const url = next.assetId ? ctx.assetUrl?.(next.assetId, next.kind) : undefined
      if (!url || url === loading) return
      loading = url
      loadTexture(url)
        .then((tex) => {
          if (destroyed || loading !== url) return
          texture = tex
          draw(current)
        })
        .catch(() => {
          // 加载失败保留占位卡片
        })
    },
    setDetail(next) {
      if (next === high) return
      high = next
      draw(current)
    },
    destroy() {
      destroyed = true
      display.destroy({ children: true })
    },
  }
  view.update(el)
  return view
}

/** 兼容旧名 */
export const imageRenderer = mediaRenderer

/**
 * Markdown：只画底板，正文由 DOM 覆盖层渲染。
 * 缩得很小时覆盖层隐藏，用几条灰线示意正文，不画文字。
 */
export const markdownRenderer: ElementRenderer = (el) => {
  const display = new Container()
  const bg = new Graphics()
  display.addChild(bg)
  let high = true
  let current = el
  const view: ElementView = {
    display,
    update(next) {
      current = next
      const { w, h } = next
      plate(bg.clear(), w, h)
      if (!high) {
        const pad = Math.min(24, w / 8)
        const step = Math.max(28, h / 10)
        for (let y = pad, i = 0; y + 10 < h - pad; y += step, i++) {
          const lw = (w - pad * 2) * (i === 0 ? 0.5 : i % 3 === 2 ? 0.7 : 1)
          bg.roundRect(pad, y, lw, i === 0 ? 14 : 8, 4)
        }
        bg.fill({ color: theme.placeholder.color, alpha: theme.placeholder.alpha })
      }
    },
    setDetail(next) {
      high = next
      view.update(current)
    },
    destroy: () => display.destroy({ children: true }),
  }
  view.update(el)
  return view
}

/** 节点卡片的版式（局部坐标），DOM 覆盖层按同样的数值排版 */
export const NODE_LAYOUT = { header: 36, footer: 36, pad: 8 } as const

/** 节点的预览区：卡片去掉标题栏和底栏 */
export function nodeBody(w: number, h: number) {
  const { header, footer, pad } = NODE_LAYOUT
  return { x: pad, y: header, w: Math.max(0, w - pad * 2), h: Math.max(0, h - header - footer) }
}

/**
 * 工作流节点：底板 + 当前结果的预览图（等比放进预览区）。
 * 标题、状态、文本结果和操作按钮由 DOM 覆盖层在正常细节下绘制；
 * 图片在 GPU 里画，缩小后整张画布仍能看到每个节点的产出。
 */
export const nodeRenderer: ElementRenderer = (el, ctx) => {
  const display = new Container()
  const bg = new Graphics()
  display.addChild(bg)
  let texture: Texture | undefined
  let loading: string | undefined
  let destroyed = false
  let high = true
  let current = el

  const draw = (next: CanvasElement) => {
    const { w, h } = next
    const status = next.run?.status
    const accent = (status && theme.status[status]) ?? theme.kinds.node
    const loud = status === 'running' || status === 'failed'
    bg.clear()
      .roundRect(0, 0, w, h, RADIUS)
      .fill({ color: theme.surface })
      .stroke({
        color: loud ? accent : theme.line.color,
        alpha: loud ? 0.9 : theme.line.alpha,
        width: loud ? 1.5 : 1,
      })
    const body = nodeBody(w, h)
    if (texture && body.w > 0 && body.h > 0) {
      const k = Math.min(body.w / texture.width, body.h / texture.height)
      const tw = texture.width * k
      const th = texture.height * k
      bg.roundRect(body.x + (body.w - tw) / 2, body.y + (body.h - th) / 2, tw, th, 10).fill({
        texture,
        textureSpace: 'local',
      })
    } else if (!high) {
      // 缩小时用色条示意节点类型和状态
      bg.roundRect(12, 12, Math.min(48, w - 24), 6, 3).fill({ color: accent, alpha: 0.8 })
    }
  }

  const view: ElementView = {
    display,
    update(next) {
      current = next
      const r = currentResult(next)
      const v = r?.value
      const url =
        v && v.type !== 'text' && v.type !== 'json' ? ctx.assetUrl?.(v.assetId, v.type) : undefined
      if (!url) {
        texture = undefined
        loading = undefined
      }
      draw(next)
      if (!url || url === loading) return
      loading = url
      loadTexture(url)
        .then((tex) => {
          if (destroyed || loading !== url) return
          texture = tex
          draw(current)
        })
        .catch(() => {
          // 加载失败只显示底板
        })
    },
    setDetail(next) {
      if (next === high) return
      high = next
      draw(current)
    },
    destroy() {
      destroyed = true
      display.destroy({ children: true })
    },
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
      this.register('image', mediaRenderer)
      this.register('video', mediaRenderer)
      this.register('audio', mediaRenderer)
      this.register('markdown', markdownRenderer)
      this.register('node', nodeRenderer)
    }
  }

  register(kind: ElementKind, renderer: ElementRenderer) {
    this.map.set(kind, renderer)
  }

  create(el: CanvasElement, ctx: RenderContext): ElementView {
    return (this.map.get(el.kind) ?? cardRenderer)(el, ctx)
  }
}

import { type CanvasElement, elementMedia, type ElementKind } from '@plein/doc'
import { Container, Graphics, Text, type Texture, type Shader } from 'pixi.js'
import { theme } from './theme'
import { previewTextures, type TextureOwner, TextureSlot } from './textures'

/** 预览图档位：缩得很小时用小图，省下载、解码和显存 */
export type PreviewSize = 'small' | 'large'

export interface RenderContext {
  /** Applied before the first update, so distant elements never request the large preview first. */
  initialDetail?: boolean
  /** Engine-owned leases into the shared Pixi preview cache. */
  textures?: TextureOwner
  /** 引擎拥有的 WebGL 预览程序；只有底色和一张预览纹理，不扩展通用渲染器限制。 */
  previewShader?: () => Shader | undefined
  /** 资产在画布上的预览图 URL：图片缩略图、视频封面、音频波形 */
  assetUrl?: (assetId: string, kind: ElementKind, size: PreviewSize) => string | undefined
  /** 媒体预览加载后报告其像素尺寸，用来按内容校正元素尺寸 */
  onContentSize?: (id: string, w: number, h: number) => void
  /** 异步内容（纹理）就绪后请求重新渲染；引擎只在画面有变化时才渲染 */
  invalidate?: () => void
}

/** 渲染器产出的显示对象，按元素局部坐标 (0,0)-(w,h) 绘制 */
export interface ElementView {
  display: Container
  update(el: CanvasElement): void
  /** 细节层级：缩得很小时隐藏文字等细节，减少绘制开销 */
  setDetail?(high: boolean): void
  /** Available only on views that request a media preview. */
  previewStatus?(): { requested: boolean; ready: boolean; pending: boolean; failed: boolean }
  destroy(): void
}

export type ElementRenderer = (el: CanvasElement, ctx: RenderContext) => ElementView

const RADIUS = 16

/** 内置图形的 context 由卡片创建；素材纹理仍由纹理池共享和释放。 */
function destroyDisplay(display: Container) {
  display.destroy({ children: true, context: true })
}

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
    destroy: () => destroyDisplay(display),
  }
  view.update(el)
  return view
}

const cardRenderer: ElementRenderer = (el) => card(el)

/** `#rrggbb` 转数值，格式不对时返回 undefined */
function parseColor(color: string | undefined) {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? Number.parseInt(color.slice(1), 16) : undefined
}

/** Frame：半透明底 + 边框，标题在框外左上 */
const frameRenderer: ElementRenderer = (el) => {
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
      const tint = parseColor(next.color)
      bg.clear().roundRect(0, 0, next.w, next.h, 20)
      // 设了颜色的 Frame：同色淡底 + 实色边框，明暗主题下都看得出
      if (tint === undefined)
        bg.fill({ color: f.fill, alpha: f.fillAlpha }).stroke({
          color: f.line,
          alpha: f.lineAlpha,
          width: 1,
        })
      else bg.fill({ color: tint, alpha: 0.08 }).stroke({ color: tint, alpha: 0.55, width: 1.5 })
      label.style.fill = tint ?? theme.label
      label.text = titleOf(next)
    },
    setDetail(high) {
      label.visible = high
    },
    destroy: () => destroyDisplay(display),
  }
  view.update(el)
  return view
}

/**
 * 媒体元素：底板 + 预览纹理（图片缩略图 / 视频封面 / 音频波形）。
 * 纹理未加载或加载失败时显示占位卡片。
 */
const mediaRenderer: ElementRenderer = (el, ctx) => {
  const display = new Container()
  const bg = new Graphics()
  const glyph = new Graphics()
  const label = new Text({ text: '', style: labelStyle, resolution: 2 })
  label.position.set(12, 10)
  display.addChild(bg, glyph, label)
  const owner = ctx.textures ?? previewTextures.createOwner()
  const slot = new TextureSlot(owner)
  /** 已加载过大图：缩小时不再换回小图 */
  let large = false
  /** 已按哪个资产的大图校正过尺寸，不再重复写文档 */
  let sized: string | undefined
  let high = ctx.initialDetail ?? true
  let current = el

  const draw = (next: CanvasElement) => {
    const { w, h, kind } = next
    const texture = slot.texture
    // 正常大小的三段预览几何原本就不合批，保留其静态缓冲；小卡片仍用自动策略。
    bg.context.customShader =
      texture && Math.min(w, h) >= RADIUS * 2 ? ctx.previewShader?.() : undefined
    bg.clear().roundRect(0, 0, w, h, RADIUS).fill({ color: theme.surface })
    if (texture) {
      // 纹理按形状包围盒铺满（textureSpace: local），省掉昂贵的遮罩
      bg.roundRect(0, 0, w, h, RADIUS).fill({ texture, textureSpace: 'local' })
    } else if (high)
      bg.roundRect(12, h - 16, Math.min(40, w - 24), 3, 1.5).fill({
        color: theme.kinds[kind],
        alpha: 0.8,
      })
    // 描边在预览之上：浅色图片和透明素材也保留与其他卡片一致的边界。
    bg.roundRect(0, 0, w, h, RADIUS).stroke({
      color: theme.line.color,
      alpha: theme.line.alpha,
      width: 1,
    })
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
    previewStatus: () => slot.status,
    update(next) {
      if (next.assetId !== current.assetId) large = false
      current = next
      const size = high || large ? 'large' : 'small'
      const url = next.assetId ? ctx.assetUrl?.(next.assetId, next.kind, size) : undefined
      slot.setSource(next.assetId, url, (tex) => {
        if (size === 'large') large = true
        draw(current)
        ctx.invalidate?.()
        // 按大图校正比例：小图边长取整后比例有误差
        if (size !== 'large' || sized === current.assetId) return
        sized = current.assetId
        ctx.onContentSize?.(current.id, tex.width, tex.height)
      })
      draw(next)
    },
    setDetail(next) {
      if (next === high) return
      high = next
      // 放大回正常细节时换上大图（加载完之前先显示小图）
      view.update(current)
    },
    destroy() {
      slot.destroy()
      if (!ctx.textures) owner.dispose()
      destroyDisplay(display)
    },
  }
  view.update(el)
  return view
}

/**
 * Markdown：只画底板，正文由 DOM 覆盖层渲染。
 * 缩得很小时覆盖层隐藏，用几条灰线示意正文，不画文字。
 */
const markdownRenderer: ElementRenderer = (el) => {
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
    destroy: () => destroyDisplay(display),
  }
  view.update(el)
  return view
}

/** 节点卡片的版式：标题行在卡片上方（局部坐标 y < 0），卡片本体整块用来展示结果 */
export const NODE_LAYOUT = { title: 28 } as const

/**
 * 工作流节点：底板 + 当前结果的预览图。
 * 结果和卡片比例一致时铺满卡片（卡片即结果），否则等比放进卡片居中。
 * 标题、状态、文本结果和操作由 DOM 覆盖层在正常细节下绘制；
 * 图片在 GPU 里画，缩小后整张画布仍能看到每个节点的产出。
 */
const nodeRenderer: ElementRenderer = (el, ctx) => {
  const display = new Container()
  const bg = new Graphics()
  display.addChild(bg)
  const owner = ctx.textures ?? previewTextures.createOwner()
  const slot = new TextureSlot(owner)
  /** 当前结果已加载过大图：缩小时不再换回小图 */
  let largeOf: string | undefined
  let high = ctx.initialDetail ?? true
  let current = el

  const draw = (next: CanvasElement) => {
    const { w, h } = next
    const texture = slot.texture
    const fit = texture ? Math.min(w / texture.width, h / texture.height) : 0
    // 极端长宽比的内嵌预览原本仍可合批；这些几何沿用默认程序。
    bg.context.customShader =
      texture && Math.min(w, h, texture.width * fit, texture.height * fit) >= RADIUS * 2
        ? ctx.previewShader?.()
        : undefined
    const status = next.run?.status
    const accent = (status && theme.status[status]) ?? theme.kinds.node
    const loud = status === 'running' || status === 'failed' || status === 'queued'
    bg.clear().roundRect(0, 0, w, h, RADIUS).fill({ color: theme.surface })
    if (texture && w > 0 && h > 0) {
      const k = Math.min(w / texture.width, h / texture.height)
      const tw = texture.width * k
      const th = texture.height * k
      // 比例几乎一致：铺满卡片，圆角与卡片相同
      if (Math.abs(tw - w) < 2 && Math.abs(th - h) < 2)
        bg.roundRect(0, 0, w, h, RADIUS).fill({ texture, textureSpace: 'local' })
      else
        bg.roundRect((w - tw) / 2, (h - th) / 2, tw, th, 10).fill({
          texture,
          textureSpace: 'local',
        })
    } else if (!high) {
      // 缩小时用色条示意节点类型和状态
      bg.roundRect(12, 12, Math.min(48, w - 24), 6, 3).fill({ color: accent, alpha: 0.8 })
    }
    bg.roundRect(0, 0, w, h, RADIUS).stroke({
      color: loud ? accent : theme.line.color,
      alpha: loud ? 0.9 : theme.line.alpha,
      width: loud ? 1.5 : 1,
    })
  }

  const view: ElementView = {
    display,
    previewStatus: () => slot.status,
    update(next) {
      current = next
      const media = elementMedia(next)
      const size = high || largeOf === media?.assetId ? 'large' : 'small'
      const url = media ? ctx.assetUrl?.(media.assetId, media.kind, size) : undefined
      slot.setSource(media?.assetId, url, () => {
        if (size === 'large') largeOf = media?.assetId
        draw(current)
        ctx.invalidate?.()
      })
      draw(next)
    },
    setDetail(next) {
      if (next === high) return
      high = next
      view.update(current)
    },
    destroy() {
      slot.destroy()
      if (!ctx.textures) owner.dispose()
      destroyDisplay(display)
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

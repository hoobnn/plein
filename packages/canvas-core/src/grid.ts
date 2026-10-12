import { CanvasSource, Texture, TilingSprite } from 'pixi.js'
import type { Camera } from './camera'
import { theme } from './theme'

/** 世界坐标里的点距；按缩放 ×4 / ÷4 分级，屏幕上保持在 [MIN_STEP, MAX_STEP] */
const BASE_STEP = 24
const MIN_STEP = 12
const MAX_STEP = 96
/** 点的半径（屏幕像素） */
const DOT_RADIUS = 0.9

/**
 * 屏幕空间点阵背景：一张只含一个点的小纹理平铺。
 * 平移只改平铺偏移，缩放只改平铺比例，不再每帧重画上千个圆。
 * 纹理按整数点距缓存，比例误差不超过 4%，点的大小看不出变化。
 */
export class DotGrid {
  readonly display = new TilingSprite({ texture: Texture.EMPTY })
  /** 按点距和像素密度缓存 */
  private textures = new Map<number, Texture>()

  /** 换主题后点的颜色变了，丢掉缓存 */
  setTheme() {
    // 先摘下正在用的纹理，再销毁缓存，下一次 update 换上新纹理
    this.display.texture = Texture.EMPTY
    for (const t of this.textures.values()) t.destroy(true)
    this.textures.clear()
  }

  update(camera: Camera) {
    const { x, y, zoom, width, height } = camera
    let step = BASE_STEP * zoom
    while (step < MIN_STEP) step *= 4
    while (step > MAX_STEP) step /= 4
    const size = Math.round(step)
    const texture = this.texture(size)
    const sprite = this.display
    if (sprite.texture !== texture) sprite.texture = texture
    sprite.width = width
    sprite.height = height
    const k = step / size
    sprite.tileScale.set(k)
    // 纹理里的点在格子中心；原点处要有一个点，偏移半格
    sprite.tilePosition.set(x - step / 2, y - step / 2)
  }

  destroy() {
    this.setTheme()
    this.display.destroy()
  }

  private texture(size: number) {
    // 窗口拖到不同像素密度的屏幕上时换一套纹理，点不发虚
    const res = Math.max(1, Math.ceil(window.devicePixelRatio || 1))
    const key = size * 16 + res
    let t = this.textures.get(key)
    if (t) return t
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size * res
    const g = canvas.getContext('2d')!
    g.fillStyle = `#${theme.grid.color.toString(16).padStart(6, '0')}`
    g.globalAlpha = theme.grid.alpha
    g.beginPath()
    g.arc((size * res) / 2, (size * res) / 2, DOT_RADIUS * res, 0, Math.PI * 2)
    g.fill()
    t = new Texture({ source: new CanvasSource({ resource: canvas, resolution: res }) })
    this.textures.set(key, t)
    return t
  }
}

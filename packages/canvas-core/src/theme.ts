import type { ElementKind, PortType, RunStatus } from '@plein/doc'

/**
 * 画布（GPU 层）的配色。外壳的 CSS 令牌与这里一一对应，切换明暗主题时两边一起换。
 * 渲染器在绘制时读取 `theme`，`Engine.setTheme` 更新它并重画全部元素。
 */
export interface CanvasTheme {
  name: 'dark' | 'light'
  background: number
  grid: { color: number; alpha: number }
  /** 卡片底板 */
  surface: number
  /** 卡片描边 */
  line: { color: number; alpha: number }
  frame: { fill: number; fillAlpha: number; line: number; lineAlpha: number }
  /** 画布上的文字（元素标题、Frame 名） */
  label: number
  /** Markdown 缩略时的占位线 */
  placeholder: { color: number; alpha: number }
  /** 选中、框选、手柄 */
  accent: number
  /** 吸附参考线 */
  guide: number
  edge: { color: number; alpha: number }
  /** 端口和手柄的内芯 */
  knob: number
  ports: Record<PortType, number>
  kinds: Record<ElementKind, number>
  status: Partial<Record<RunStatus, number>>
}

export const DARK_THEME: CanvasTheme = {
  name: 'dark',
  background: 0x0a0a0a,
  grid: { color: 0xffffff, alpha: 0.075 },
  surface: 0x161616,
  line: { color: 0xffffff, alpha: 0.09 },
  frame: { fill: 0xffffff, fillAlpha: 0.025, line: 0xffffff, lineAlpha: 0.12 },
  label: 0xb0b0b0,
  placeholder: { color: 0xffffff, alpha: 0.1 },
  accent: 0x4d8dff,
  guide: 0xff5c8a,
  edge: { color: 0x8a8a8a, alpha: 0.7 },
  knob: 0x161616,
  ports: {
    text: 0xfbbf24,
    image: 0x38bdf8,
    video: 0xfb7185,
    audio: 0x34d399,
    json: 0xc084fc,
    any: 0xa3a3a3,
  },
  kinds: {
    image: 0x38bdf8,
    video: 0xfb7185,
    audio: 0x34d399,
    markdown: 0xfbbf24,
    node: 0xd4d4d4,
    frame: 0xa3a3a3,
    sequence: 0xfb7185,
  },
  status: { queued: 0x8a8a8a, running: 0x4d8dff, failed: 0xf87171 },
}

export const LIGHT_THEME: CanvasTheme = {
  name: 'light',
  background: 0xfafafa,
  grid: { color: 0x171717, alpha: 0.11 },
  surface: 0xffffff,
  line: { color: 0x171717, alpha: 0.1 },
  frame: { fill: 0x171717, fillAlpha: 0.025, line: 0x171717, lineAlpha: 0.12 },
  label: 0x525252,
  placeholder: { color: 0x171717, alpha: 0.08 },
  accent: 0x2869f0,
  guide: 0xe8336f,
  edge: { color: 0x9a9a9a, alpha: 0.8 },
  knob: 0xffffff,
  ports: {
    text: 0xd97706,
    image: 0x0284c7,
    video: 0xe11d48,
    audio: 0x059669,
    json: 0x9333ea,
    any: 0x8e8e8e,
  },
  kinds: {
    image: 0x0284c7,
    video: 0xe11d48,
    audio: 0x059669,
    markdown: 0xd97706,
    node: 0x525252,
    frame: 0x8e8e8e,
    sequence: 0xe11d48,
  },
  status: { queued: 0x9a9a9a, running: 0x2869f0, failed: 0xdc4c4c },
}

/** 当前生效的配色（渲染器在绘制时读取） */
export const theme: CanvasTheme = { ...DARK_THEME }

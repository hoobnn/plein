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
  background: 0x0b0b0d,
  grid: { color: 0xffffff, alpha: 0.075 },
  surface: 0x17171a,
  line: { color: 0xffffff, alpha: 0.09 },
  frame: { fill: 0xffffff, fillAlpha: 0.025, line: 0xffffff, lineAlpha: 0.12 },
  label: 0x9b9ba3,
  placeholder: { color: 0xffffff, alpha: 0.1 },
  accent: 0x8b7cff,
  guide: 0xff5c8a,
  edge: { color: 0x8a8a94, alpha: 0.7 },
  knob: 0x17171a,
  ports: {
    text: 0xf5c66b,
    image: 0x5cb8ff,
    video: 0xa98bff,
    audio: 0x4fd69c,
    json: 0xff9f6b,
    any: 0xa1a1aa,
  },
  kinds: {
    image: 0x5cb8ff,
    video: 0xa98bff,
    audio: 0x4fd69c,
    markdown: 0xf5c66b,
    node: 0x8b7cff,
    frame: 0xa1a1aa,
    sequence: 0xff8fb1,
  },
  status: { queued: 0x8a8a94, running: 0x8b7cff, failed: 0xf87171 },
}

export const LIGHT_THEME: CanvasTheme = {
  name: 'light',
  background: 0xf3f3f5,
  grid: { color: 0x18181b, alpha: 0.11 },
  surface: 0xffffff,
  line: { color: 0x18181b, alpha: 0.1 },
  frame: { fill: 0x18181b, fillAlpha: 0.025, line: 0x18181b, lineAlpha: 0.12 },
  label: 0x6b6b74,
  placeholder: { color: 0x18181b, alpha: 0.08 },
  accent: 0x6c5cf5,
  guide: 0xe8336f,
  edge: { color: 0x9a9aa3, alpha: 0.8 },
  knob: 0xffffff,
  ports: {
    text: 0xd99a14,
    image: 0x1f8fe0,
    video: 0x7a5cf0,
    audio: 0x17a873,
    json: 0xe5702e,
    any: 0x8e8e96,
  },
  kinds: {
    image: 0x1f8fe0,
    video: 0x7a5cf0,
    audio: 0x17a873,
    markdown: 0xd99a14,
    node: 0x6c5cf5,
    frame: 0x8e8e96,
    sequence: 0xe0578a,
  },
  status: { queued: 0x9a9aa3, running: 0x6c5cf5, failed: 0xdc4c4c },
}

/** 当前生效的配色（渲染器在绘制时读取） */
export const theme: CanvasTheme = { ...DARK_THEME }

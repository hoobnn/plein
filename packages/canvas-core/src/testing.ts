/**
 * 测试工具：只给单测用，不从主入口导出。
 * 只替代 Pixi GPU 初始化与浏览器 DOM 边界；Engine.init 的相机、文档订阅、交互与撤销接线保持真实。
 */
import type { PleinDoc } from '@plein/doc'
import { type Application, type Container, RendererType } from 'pixi.js'
import { vi } from 'vite-plus/test'
import { Engine } from './engine'
import type { DotGrid } from './grid'
import type { HighlightLayer } from './highlight'

/** 宿主元素：事件、指针捕获与固定布局 */
export class FakeHost extends EventTarget {
  style = { cursor: '', transform: '' }
  captured = new Set<number>()
  appendChild() {}
  closest() {
    return null
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 } as DOMRect
  }
  setPointerCapture(id: number) {
    this.captured.add(id)
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id)
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id)
  }
}

/** 构造一个指针事件；node 环境没有 PointerEvent，按需补实例属性 */
export function pointerEvent(type: string, props: Record<string, unknown> = {}) {
  const e = new Event(type, { cancelable: true })
  const all = { pointerId: 1, button: 0, pointerType: 'mouse', clientX: 0, clientY: 0, ...props }
  for (const [key, value] of Object.entries(all)) Object.defineProperty(e, key, { value })
  return e as PointerEvent
}

/**
 * 运行真实 Engine.init（使用桩化的 Pixi Application）。
 * 返回 cleanup，由调用方在 afterEach 中执行。
 */
export async function initEngine(doc: PleinDoc, opts: { width?: number; height?: number } = {}) {
  const { width = 1200, height = 800 } = opts
  const win = Object.assign(new EventTarget(), { devicePixelRatio: 1 })
  vi.stubGlobal('window', win)
  vi.stubGlobal('HTMLElement', FakeHost)
  for (const name of [
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLMediaElement',
  ])
    vi.stubGlobal(name, class extends FakeHost {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const host = new FakeHost()
  const engine = new Engine({ host: host as unknown as HTMLElement, doc })
  const internals = engine as unknown as {
    app: Application
    world: Container
    highlight: HighlightLayer
    grid: DotGrid
  }
  const { app } = internals
  // 点阵底纹靠 DOM canvas 生成纹理，与被测逻辑无关
  vi.spyOn(internals.grid, 'update').mockImplementation(() => {})
  const renderer = Object.assign(new EventTarget(), {
    type: RendererType.WEBGPU,
    canvas: {},
    screen: { width, height },
    scheduler: { repeat: () => 0, cancel() {} },
    on() {},
    off() {},
  })
  let frame = () => {}
  const ticker = {
    add(fn: () => void) {
      frame = fn
    },
    remove() {},
  }
  vi.spyOn(app, 'init').mockImplementation(async () => {
    Object.assign(app, { renderer, ticker, resize() {}, render() {} })
  })
  // 镜头动画按 performance.now 取进度；时钟由 tick 推进
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.spyOn(app, 'destroy').mockImplementation(() => {})
  await engine.init()
  const cleanup = () => {
    engine.destroy()
    app.stage.destroy({ children: true })
    internals.world.destroy({ children: true })
    internals.highlight.destroy()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
  /** 把时钟推进到 at 毫秒后跑一帧（真实 Engine.frame） */
  const tick = (at: number) => {
    now = at
    frame()
  }
  return { engine, host, tick, cleanup }
}

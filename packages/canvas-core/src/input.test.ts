import { afterEach, expect, it, vi } from 'vite-plus/test'
import { Camera } from './camera'
import { attachInput, isControlTarget, isEditableTarget, type PanState } from './input'

/** 只替代浏览器事件和指针捕获边界；相机、平移、惯性和触屏状态机使用真实实现。 */
class Surface extends EventTarget {
  style = { cursor: '' }
  captured = new Set<number>()
  isContentEditable = false
  area = ''
  closest(selector: string) {
    return (this.area === 'overlay' && selector.includes('[role="dialog"]')) ||
      (this.area === 'editor' && selector.includes('[data-plein-active]')) ||
      (this.area === 'control' && selector.includes('button,'))
      ? this
      : null
  }
  getBoundingClientRect() {
    return { left: 10, top: 20, width: 800, height: 600 }
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
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function event(type: string, props: Record<string, unknown> = {}, target?: EventTarget) {
  const e = Object.assign(new Event(type, { cancelable: true }), props)
  if (target) Object.defineProperty(e, 'target', { value: target })
  return e
}
function setup(pan: PanState = { space: false, hand: false }) {
  const win = new EventTarget(),
    el = new Surface(),
    camera = new Camera()
  camera.setViewport(800, 600)
  vi.stubGlobal('window', win)
  vi.stubGlobal('HTMLElement', Surface)
  for (const name of [
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLMediaElement',
  ])
    vi.stubGlobal(name, class extends Surface {})
  let now = 1000,
    next = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.set(++next, fn)
    return next
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const input = attachInput(el as unknown as HTMLElement, camera, pan)
  disposers.push(input.dispose)
  const pointer = (type: string, id = 1, x = 0, y = 0, extra: Record<string, unknown> = {}) => {
    const e = event(type, {
      pointerId: id,
      clientX: x,
      clientY: y,
      button: 0,
      pointerType: 'mouse',
      ...extra,
    })
    el.dispatchEvent(e)
    return e
  }
  return {
    win,
    el,
    camera,
    pan,
    input,
    pointer,
    frames,
    advance(ms: number) {
      now += ms
    },
    frame() {
      for (const [id, fn] of [...frames]) {
        frames.delete(id)
        fn(now)
      }
    },
  }
}
it('滚轮平移与光标锚定缩放使用元素局部坐标，行滚动与触控板缩放均有效', () => {
  const f = setup()
  const wheel = event('wheel', {
    clientX: 110,
    clientY: 220,
    deltaX: 30,
    deltaY: -40,
    deltaMode: 0,
  })
  f.el.dispatchEvent(wheel)
  expect(wheel.defaultPrevented).toBe(true)
  expect([f.camera.x, f.camera.y, f.camera.zoom]).toEqual([-30, 40, 1])
  const world = f.camera.screenToWorld(100, 200)
  f.el.dispatchEvent(
    event('wheel', {
      clientX: 110,
      clientY: 220,
      deltaX: 0,
      deltaY: -10,
      deltaMode: 0,
      ctrlKey: true,
    }),
  )
  expect(f.camera.screenToWorld(100, 200)).toEqual(world)
  expect(f.camera.zoom).toBeCloseTo(Math.exp(0.1))
  f.el.dispatchEvent(
    event('wheel', {
      clientX: 110,
      clientY: 220,
      deltaX: 0,
      deltaY: -2,
      deltaMode: 1,
      metaKey: true,
    }),
  )
  expect(f.camera.zoom).toBeCloseTo(Math.exp(0.2))
})
it('输入框、媒体、浮层和控件保留空格，普通画布仅非重复非输入法按键进入平移', () => {
  const f = setup()
  for (const name of [
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLMediaElement',
  ]) {
    const Type = (globalThis as unknown as Record<string, new () => Surface>)[name]!
    const target = new Type()
    expect(isEditableTarget(target)).toBe(true)
    f.win.dispatchEvent(event('keydown', { code: 'Space' }, target))
    expect(f.pan.space).toBe(false)
  }
  for (const area of ['overlay', 'editor', 'control']) {
    const target = new Surface()
    target.area = area
    expect(area === 'control' ? isControlTarget(target) : isEditableTarget(target)).toBe(true)
    f.win.dispatchEvent(event('keydown', { code: 'Space' }, target))
    expect(f.pan.space).toBe(false)
  }
  const editable = new Surface()
  editable.isContentEditable = true
  expect(isEditableTarget(editable)).toBe(true)
  for (const props of [{ repeat: true }, { isComposing: true }])
    f.win.dispatchEvent(event('keydown', { code: 'Space', ...props }))
  const stopped = event('keydown', { code: 'Space' })
  stopped.preventDefault()
  f.win.dispatchEvent(stopped)
  expect(f.pan.space).toBe(false)
  const space = event('keydown', { code: 'Space' })
  f.win.dispatchEvent(space)
  expect(space.defaultPrevented).toBe(true)
  expect(f.el.style.cursor).toBe('grab')
  f.win.dispatchEvent(event('keyup', { code: 'Space' }))
  expect(f.pan.space).toBe(false)
  expect(f.el.style.cursor).toBe('')
})

it.each([
  [0, -2, 3],
  [1, -32, 48],
  [2, -1600, 1800],
])('平移单位 %s 使用屏幕像素，两轴保留方向且不改变缩放', (mode, x, y) => {
  const f = setup()
  const wheel = event('wheel', {
    deltaMode: mode,
    deltaX: 2,
    deltaY: -3,
    clientX: 110,
    clientY: 220,
  })
  f.el.dispatchEvent(wheel)
  expect(wheel.defaultPrevented).toBe(true)
  expect([f.camera.x, f.camera.y, f.camera.zoom]).toEqual([x, y, 1])
  // 按页滚动使用当前视口，不能缓存缩放前或调整窗口前的尺寸。
  f.camera.setViewport(1000, 700)
  f.el.dispatchEvent(
    event('wheel', { deltaMode: mode, deltaX: -2, deltaY: 3, clientX: 110, clientY: 220 }),
  )
  expect([f.camera.x, f.camera.y, f.camera.zoom]).toEqual(mode === 2 ? [400, -300, 1] : [0, 0, 1])
})
it('普通左键不平移，中键只跟随捕获指针并接收合并事件，停稳后释放不启动旧惯性', () => {
  const f = setup()
  f.pointer('pointerdown')
  f.pointer('pointermove', 1, 30, 20)
  expect(f.camera.x).toBe(0)
  f.pointer('pointerdown', 1, 0, 0, { button: 1 })
  f.pointer('pointerdown', 2, 100, 100, { button: 1 })
  f.pointer('pointermove', 2, 200, 200)
  f.pointer('pointerup', 2)
  f.pointer('pointercancel', 2)
  expect([...f.el.captured]).toEqual([1])
  f.advance(16)
  f.pointer('pointermove', 1, 40, 30, {
    getCoalescedEvents: () => [
      { clientX: 20, clientY: 10 },
      { clientX: 40, clientY: 30 },
    ],
  })
  expect([f.camera.x, f.camera.y]).toEqual([40, 30])
  f.advance(120)
  f.pointer('pointerup', 1)
  expect(f.frames.size).toBe(0)
  expect(f.el.captured.size).toBe(0)
})
it('松手惯性逐步衰减，外部导航接管立即取消且旧拖动不能再移动相机', () => {
  const f = setup({ hand: true, space: false })
  f.pointer('pointerdown')
  f.advance(16)
  f.pointer('pointermove', 1, 16, 0)
  f.pointer('pointerup')
  f.frame()
  expect(f.camera.x).toBeGreaterThan(16)
  expect(f.frames.size).toBe(1)
  f.camera.panBy(200, 0)
  const at = f.camera.x
  expect(f.frames.size).toBe(0)
  f.pointer('pointermove', 1, 300, 0)
  f.frame()
  expect(f.camera.x).toBe(at)
  f.pointer('pointerdown', 3)
  f.advance(16)
  f.pointer('pointermove', 3, 8, 0)
  f.pointer('pointerup', 3)
  for (let i = 0; i < 200 && f.frames.size; i++) f.frame()
  expect(f.frames.size).toBe(0)
})
it.each(['pointercancel', 'lostpointercapture', 'blur', 'wheel'] as const)(
  '%s 中断平移后释放捕获并丢弃旧速度',
  (type) => {
    const f = setup({ hand: false, space: true })
    f.pointer('pointerdown')
    f.advance(16)
    f.pointer('pointermove', 1, 20, 10)
    if (type === 'blur') f.win.dispatchEvent(event('blur'))
    else if (type === 'wheel')
      f.el.dispatchEvent(event('wheel', { deltaX: 0, deltaY: 0, clientX: 10, clientY: 20 }))
    else f.pointer(type)
    expect(f.el.captured.size).toBe(0)
    expect(f.frames.size).toBe(0)
    const at = [f.camera.x, f.camera.y]
    f.pointer('pointermove', 1, 300, 300)
    f.pointer('pointerup')
    expect([f.camera.x, f.camera.y]).toEqual(at)
  },
)
it('抓手触屏单指平移、双指缩放后抬一指不跳位，取消同时释放所有触点', () => {
  const f = setup({ hand: true, space: false })
  const touch = (type: string, id: number, x: number, y = 20) =>
    f.pointer(type, id, x, y, { pointerType: 'touch' })
  touch('pointerdown', 1, 0)
  touch('pointermove', 1, 20)
  expect(f.camera.x).toBe(20)
  touch('pointerdown', 2, 120)
  touch('pointermove', 1, 40)
  expect(f.camera.zoom).toBeCloseTo(0.8)
  touch('pointerup', 2, 120)
  const x = f.camera.x
  touch('pointermove', 1, 60)
  expect(f.camera.x).toBeCloseTo(x + 20)
  touch('pointerdown', 3, 160)
  touch('pointercancel', 99, 0)
  expect(f.el.captured.size).toBe(2)
  touch('lostpointercapture', 1, 60)
  expect(f.el.captured.size).toBe(0)
  const at = [f.camera.x, f.camera.y, f.camera.zoom]
  touch('pointermove', 3, 300)
  touch('pointerup', 3, 300)
  expect([f.camera.x, f.camera.y, f.camera.zoom]).toEqual(at)
})
it('非抓手触点不接管导航，卸载后滚轮、键盘和指针不再影响相机', () => {
  const f = setup()
  f.pointer('pointerdown', 1, 0, 0, { pointerType: 'touch' })
  f.pointer('pointermove', 1, 100, 100, { pointerType: 'touch' })
  expect(f.camera.x).toBe(0)
  f.input.dispose()
  f.win.dispatchEvent(event('keydown', { code: 'Space' }))
  f.el.dispatchEvent(event('wheel', { deltaX: 100, deltaY: 100 }))
  f.pointer('pointerdown', 1, 0, 0, { button: 1 })
  f.pointer('pointermove', 1, 100, 100)
  expect([f.camera.x, f.camera.y, f.pan.space, f.el.style.cursor]).toEqual([0, 0, false, ''])
})

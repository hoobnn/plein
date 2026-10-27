// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { mockResizeObserver } from '../../testing/browser'
import { act, fireEvent, renderApp, screen } from '../../testing/render'
import { Timeline, type TrackItem } from './Timeline'
import { Playhead } from './playhead'

vi.mock('./media', () => ({ Filmstrip: () => null, Waveform: () => null }))
const heads: Playhead[] = []
afterEach(() => {
  for (const head of heads.splice(0)) head.dispose()
})
function setup(options: { readOnly?: boolean; ready?: boolean; total?: number } = {}) {
  const observer = mockResizeObserver()
  const playhead = new Playhead()
  heads.push(playhead)
  const total = options.total ?? 10
  playhead.setTotal(total)
  const items: TrackItem[] = ['甲', '乙'].map((name, index) => ({
    key: name,
    index,
    name,
    assetId: '',
    pending: false,
    timingReady: options.ready !== false,
    kind: 'video',
    start: (index * total) / 2,
    length: total / 2,
    full: total / 2,
    in: 0,
    aspect: 1,
    speed: 1,
    lines: [],
    cues: [],
  }))
  let identity = 'original'
  const onMove = vi.fn(),
    onTrim = vi.fn(),
    onSelect = vi.fn()
  const props = {
    items,
    total,
    playhead,
    onMove,
    onTrim,
    onSelect,
    readOnly: options.readOnly,
    interactionKey: 'original',
    readInteractionKey: () => identity,
  }
  const rendered = renderApp(<Timeline {...props} />)
  const scroller = rendered.container.querySelector<HTMLElement>('.seq-scroll')!
  Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 1136 })
  act(() => observer.resize(scroller, 1136, 200))
  return {
    ...rendered,
    props,
    playhead,
    items,
    onMove,
    onTrim,
    onSelect,
    scroller,
    observer,
    invalidate: () => {
      identity = 'changed'
    },
    clip: (index = 0) => screen.getByRole('button', { name: items[index]!.name }),
  }
}
function drag(target: Element, from = 400, to = 450) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: from })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to })
}

it.each([false, true])('键盘选择与定位镜头只改变播放头，只读=%s', async (readOnly) => {
  const f = setup({ readOnly })
  await f.user.tab()
  const clip = f.clip(1)
  act(() => clip.focus())
  expect(f.onSelect).toHaveBeenLastCalledWith('乙')
  fireEvent.keyDown(clip, { key: 'Enter' })
  expect(f.playhead.t).toBe(5)
  act(() => f.playhead.seek(6))
  for (const extra of [{ repeat: true }, { ctrlKey: true }, { isComposing: true }])
    fireEvent.keyDown(clip, { key: ' ', ...extra })
  expect(f.playhead.t).toBe(6)
  expect(f.onMove).not.toHaveBeenCalled()
  expect(f.onTrim).not.toHaveBeenCalled()
  expect(f.container.querySelectorAll('.seq-trim').length).toBe(readOnly ? 0 : 4)
})

it('同帧内容变化后键盘和辅助激活不能使用旧镜头位置', () => {
  const f = setup()
  f.invalidate()
  fireEvent.keyDown(f.clip(1), { key: 'Enter' })
  expect(f.playhead.t).toBe(0)
  fireEvent.click(f.clip(1), { detail: 0 })
  expect(f.playhead.t).toBe(0)
  expect(f.onMove).not.toHaveBeenCalled()
})

it('时长未就绪的镜头允许查看设置，但禁止定位、修剪和排序', () => {
  const f = setup({ ready: false })
  fireEvent.keyDown(f.clip(1), { key: 'Enter' })
  drag(f.clip(1), 700, 100)
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(f.onSelect).toHaveBeenCalledWith('乙')
  expect(f.playhead.t).toBe(0)
  expect(f.onMove).not.toHaveBeenCalled()
  expect(f.container.querySelector('.seq-trim')).toBeNull()
  expect(screen.getByRole('status', { name: '镜头定位暂不可用' })).toBeTruthy()
})

it.each(['pointercancel', 'blur', 'readonly', 'identity', 'width', 'zoom', 'scroll'])(
  '修剪遇到 %s 取消，迟到松手不保存，恢复后可以重试',
  (kind) => {
    const f = setup()
    const handle = f.container.querySelector('.seq-trim-out')!
    drag(handle)
    expect(f.onTrim).toHaveBeenLastCalledWith(
      '甲',
      expect.objectContaining({ out: undefined }),
      false,
    )
    if (kind === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 1 })
    if (kind === 'blur') fireEvent(window, new Event('blur'))
    if (kind === 'readonly') f.rerender(<Timeline {...f.props} readOnly />)
    if (kind === 'identity') f.invalidate()
    if (kind === 'width')
      Object.defineProperty(f.scroller, 'clientWidth', { value: 1000, configurable: true })
    if (kind === 'zoom')
      fireEvent.change(screen.getByRole('slider', { name: '缩放' }), { target: { value: '1' } })
    if (kind === 'scroll') f.scroller.scrollLeft = 100
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(f.onTrim.mock.calls.some(([, , done]) => done)).toBe(false)
    expect(f.container.querySelector('[data-trimming]')).toBeNull()
  },
)

it('修剪以素材时长和倍速换算，非当前指针不能结束，松手只提交一次', () => {
  const f = setup()
  const handle = f.container.querySelector('.seq-trim-out')!
  drag(handle, 500, 400)
  expect(f.onTrim).toHaveBeenLastCalledWith('甲', { out: 4 }, false)
  fireEvent.pointerUp(window, { pointerId: 2 })
  expect(f.onTrim.mock.calls.some(([, , done]) => done)).toBe(false)
  fireEvent.pointerUp(window, { pointerId: 1 })
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(f.onTrim.mock.calls.filter(([, , done]) => done)).toEqual([['甲', { out: 4 }, true]])
})

it.each(['pointercancel', 'blur', 'identity', 'scroll'])('重排遇到 %s 不提交旧顺序', (kind) => {
  const f = setup()
  drag(f.clip(1), 700, 100)
  expect(f.container.querySelector('[data-moving]')).toBeTruthy()
  if (kind === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 1 })
  if (kind === 'blur') fireEvent(window, new Event('blur'))
  if (kind === 'identity') f.invalidate()
  if (kind === 'scroll') f.scroller.scrollLeft = 100
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(f.onMove).not.toHaveBeenCalled()
  expect(f.container.querySelector('[data-moving]')).toBeNull()
})

it('无效滚轮不取消有效重排，完成时把焦点移回时间线', () => {
  const f = setup()
  drag(f.clip(1), 700, 100)
  fireEvent.wheel(f.scroller, { ctrlKey: true, deltaY: 0 })
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(f.onMove).toHaveBeenCalledExactlyOnceWith(1, 0)
  expect(document.activeElement).toBe(screen.getByRole('region', { name: '时间线' }))
})

it.each(['pointercancel', 'blur', 'unmount'])('播放头 %s 后忽略迟到移动和其他指针', (kind) => {
  const f = setup()
  const ruler = f.container.querySelector('.seq-ruler')!
  drag(ruler, 312, 412)
  expect(f.playhead.t).toBe(3)
  fireEvent.pointerUp(window, { pointerId: 2 })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 512 })
  expect(f.playhead.t).toBe(4)
  if (kind === 'pointercancel') fireEvent.pointerCancel(window, { pointerId: 1 })
  if (kind === 'blur') fireEvent(window, new Event('blur'))
  if (kind === 'unmount') f.unmount()
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 612 })
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(f.playhead.t).toBe(4)
})

it('三十分钟时间线可铺满并放大到秒内细节，播放头定位保持可访问', async () => {
  const f = setup({ total: 1800 })
  const zoom = screen.getByRole<HTMLInputElement>('slider', { name: '缩放' })
  expect(Number(zoom.max)).toBeGreaterThan(Math.log(100))
  fireEvent.change(zoom, { target: { value: zoom.max } })
  expect(
    Number.parseFloat(f.container.querySelector<HTMLElement>('.seq-content')!.style.width),
  ).toBeGreaterThan(1800 * 100)
  await f.user.click(screen.getByRole('button', { name: '铺满' }))
  expect(zoom.value).toBe('0')
  expect(document.activeElement).toBe(screen.getByRole('region', { name: '时间线' }))
})

it('不足零点二秒的素材拖动入点不会产生负数或越过素材结尾', () => {
  const f = setup({ total: 0.16 })
  drag(f.container.querySelector('.seq-trim-in')!, 200, 400)
  fireEvent.pointerUp(window, { pointerId: 1 })
  expect(f.onTrim).toHaveBeenLastCalledWith('甲', { in: 0 }, true)
})

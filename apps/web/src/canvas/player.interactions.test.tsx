// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test'
import { fireEvent, renderApp, screen } from '../testing/render'
import { createPlayer } from './player'

let player: ReturnType<typeof createPlayer>
let media: HTMLMediaElement
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false })
    this.dispatchEvent(new Event('play'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => {
  player?.dispose()
  player?.node.remove()
})
function setup(kind: 'video' | 'audio' = 'video', duration = 20) {
  const view = renderApp(<div />)
  player = createPlayer(kind, '/asset.mp4', { poster: '/poster.jpg' })
  view.container.appendChild(player.node)
  media = player.node.querySelector(kind)!
  Object.defineProperty(media, 'duration', { configurable: true, value: duration })
  media.dispatchEvent(new Event('loadedmetadata'))
  media.pause()
  return view
}

it.each(['video', 'audio'] as const)('%s 键盘进度夹住边界并保留按钮本身的激活行为', (kind) => {
  setup(kind)
  const slider = screen.getByRole('slider', { name: '播放进度' })
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  expect(media.currentTime).toBe(5)
  fireEvent.keyDown(slider, { key: 'End' })
  expect(media.currentTime).toBe(20)
  fireEvent.keyDown(slider, { key: 'Home' })
  fireEvent.keyDown(slider, { key: 'ArrowLeft' })
  expect(media.currentTime).toBe(0)
  fireEvent.keyDown(slider, { key: 'ArrowUp' })
  expect(media.currentTime).toBe(5)
  fireEvent.keyDown(slider, { key: 'ArrowDown' })
  expect(media.currentTime).toBe(0)
  media.dispatchEvent(new Event('timeupdate'))
  expect(slider.getAttribute('aria-valuetext')).toBe('0:00 / 0:20')
  fireEvent.keyDown(screen.getByRole('button', { name: '静音' }), { key: ' ' })
  expect(media.paused).toBe(true)
})

it('组字、组合键、已处理按键和按住重复不改变播放状态', () => {
  setup()
  for (const params of [
    { key: 'k', isComposing: true },
    { key: 'k', keyCode: 229 },
    { key: 'm', metaKey: true },
    { key: 'ArrowRight', altKey: true },
    { key: 'k', ctrlKey: true },
    { key: 'k', repeat: true },
  ])
    fireEvent.keyDown(player.node, params)
  const handled = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })
  handled.preventDefault()
  player.node.dispatchEvent(handled)
  expect(media.paused).toBe(true)
  expect(media.currentTime).toBe(0)
  expect(media.muted).toBe(false)
  fireEvent.keyDown(player.node, { key: 'k' })
  expect(media.paused).toBe(false)
  fireEvent.keyDown(player.node, { key: 'm' })
  expect(media.muted).toBe(true)
})

it.each(['video', 'audio'] as const)(
  '%s 按钮支持键盘激活，键盘焦点阻止播放控制条自动收起',
  async (kind) => {
    vi.useFakeTimers()
    const { user } = setup(kind)
    const mute = screen.getByRole('button', { name: '静音' })
    mute.focus()
    await user.keyboard(' ')
    expect(media.muted).toBe(true)
    expect(media.paused).toBe(true)
    await user.keyboard('{Enter}')
    expect(media.muted).toBe(false)
    const play = screen.getByRole('button', { name: '播放' })
    play.focus()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('slider', { name: '播放进度' }))
    play.focus()
    await user.keyboard(' ')
    expect(media.paused).toBe(false)
    await vi.advanceTimersByTimeAsync(2300)
    expect(player.node.classList.contains('is-idle')).toBe(false)
    player.node.focus()
    await vi.advanceTimersByTimeAsync(2300)
    expect(player.node.classList.contains('is-idle')).toBe(true)
  },
)

it('全屏按钮和快捷键调用浏览器边界，退出时恢复按钮状态并清理监听', async () => {
  const { user } = setup()
  const previous = Object.getOwnPropertyDescriptor(document, 'fullscreenElement')
  const previousExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen')
  let fullscreen: Element | null = null
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreen,
  })
  const change = (value: Element | null) => {
    fullscreen = value
    document.dispatchEvent(new Event('fullscreenchange'))
  }
  const enter = vi.fn(async () => change(player.node))
  Object.assign(player.node, { requestFullscreen: enter })
  const exit = vi.fn(async () => change(null))
  Object.assign(document, { exitFullscreen: exit })
  try {
    screen.getByRole('button', { name: '全屏' }).focus()
    await user.keyboard(' ')
    expect(enter).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '退出全屏' })).toBeDefined()
    expect(media.paused).toBe(true)
    await user.keyboard('{Enter}')
    expect(exit).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '全屏' })).toBeDefined()
    fireEvent.keyDown(player.node, { key: 'f' })
    expect(enter).toHaveBeenCalledTimes(2)
    player.dispose()
    expect(exit).toHaveBeenCalledTimes(2)
  } finally {
    if (previous) Object.defineProperty(document, 'fullscreenElement', previous)
    else Reflect.deleteProperty(document, 'fullscreenElement')
    if (previousExit) Object.defineProperty(document, 'exitFullscreen', previousExit)
    else Reflect.deleteProperty(document, 'exitFullscreen')
  }
})

it.each(['pointercancel', 'lostpointercapture', 'blur', 'pendingcapture'])(
  '%s 终止拖动，其他指针不能劫持进度',
  (cancel) => {
    setup()
    const slider = screen.getByRole('slider', { name: '播放进度' })
    let captured: number | undefined
    Object.assign(slider, {
      setPointerCapture: (id: number) => {
        captured = id
      },
      hasPointerCapture: (id: number) => captured === id,
      releasePointerCapture: () => {
        captured = undefined
      },
      getBoundingClientRect: () => ({ left: 10, width: 100 }),
    })
    fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: 60 })
    expect(media.currentTime).toBe(10)
    fireEvent.pointerMove(slider, { pointerId: 2, clientX: 110 })
    fireEvent.pointerCancel(slider, { pointerId: 2 })
    expect(media.currentTime).toBe(10)
    expect(player.node.classList.contains('is-scrubbing')).toBe(true)
    if (cancel === 'blur') fireEvent(window, new Event('blur'))
    else if (cancel === 'pendingcapture') {
      captured = undefined
      fireEvent.pointerMove(slider, { pointerId: 1, clientX: 80 })
    } else fireEvent(slider, new PointerEvent(cancel, { pointerId: 1 }))
    expect(player.node.classList.contains('is-scrubbing')).toBe(false)
    expect(captured).toBeUndefined()
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: 110 })
    expect(media.currentTime).toBe(10)
    fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: 200 })
    expect(media.currentTime).toBe(20)
    fireEvent.pointerMove(slider, { pointerId: 1, clientX: -30 })
    expect(media.currentTime).toBe(0)
    player.dispose()
    expect(captured).toBeUndefined()
    expect(media.paused).toBe(true)
    expect(media.getAttribute('src')).toBeNull()
  },
)

it.each([NaN, Infinity, 0])('时长 %s 尚不可用时不进入拖动、不捕获指针', (duration) => {
  setup('video', duration)
  const slider = screen.getByRole('slider', { name: '播放进度' })
  const capture = vi.fn()
  Object.assign(slider, { setPointerCapture: capture })
  fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: 60 })
  expect(capture).not.toHaveBeenCalled()
  expect(player.node.classList.contains('is-scrubbing')).toBe(false)
  expect(slider.getAttribute('aria-disabled')).toBe('true')
})

it('加载时主动暂停导致 AbortError 不误报加载失败，真正失败可重载', async () => {
  setup('audio')
  vi.mocked(media.play).mockRejectedValueOnce(new DOMException('paused', 'AbortError'))
  fireEvent.keyDown(player.node, { key: 'k' })
  await Promise.resolve()
  expect(screen.queryByRole('button', { name: '重新加载' })).toBeNull()
  fireEvent.error(media)
  expect(screen.getByRole('status').textContent).toContain('原文件仍可用')
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }))
  expect(media.load).toHaveBeenCalledTimes(1)
  fireEvent.playing(media)
  expect(screen.queryByRole('status')).toBeNull()
})

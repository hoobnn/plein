import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { createPlayer } from './player'

vi.mock('../ui/icons', () => ({ iconElement: () => document.createElement('span') }))

class Element extends EventTarget {
  children: Element[] = []
  style: Record<string, string> = {}
  attributes = new Map<string, string>()
  className = ''
  textContent = ''
  src = ''
  hidden = false
  alt = ''
  type = ''
  title = ''
  tabIndex = 0
  private classes = new Set<string>()
  classList = {
    add: (value: string) => this.classes.add(value),
    remove: (value: string) => this.classes.delete(value),
    toggle: (value: string, on: boolean) =>
      on ? this.classes.add(value) : this.classes.delete(value),
  }

  constructor(readonly tag: string) {
    super()
  }

  appendChild(child: Element) {
    this.children.push(child)
    return child
  }

  append(...children: Element[]) {
    this.children.push(...children)
  }

  replaceChildren(...children: Element[]) {
    this.children = children
  }

  setAttribute(key: string, value: string) {
    this.attributes.set(key, value)
  }

  removeAttribute(key: string) {
    this.attributes.delete(key)
    if (key === 'src') this.src = ''
  }

  focus() {}
}

class Media extends Element {
  paused = true
  ended = false
  autoplay = false
  preload = ''
  playsInline = false
  readyState = 0
  duration = NaN
  currentTime = 0
  muted = false
  buffered = { length: 0, end: () => 0 }
  callbacks = new Map<number, () => void>()
  nextFrame = 0
  play = vi.fn(async () => {
    this.paused = false
    this.dispatchEvent(new Event('play'))
  })
  pause = vi.fn(() => {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  })
  load = vi.fn()
  requestVideoFrameCallback(callback: () => void) {
    const id = ++this.nextFrame
    this.callbacks.set(id, callback)
    return id
  }
  cancelVideoFrameCallback(id: number) {
    this.callbacks.delete(id)
  }
  presentFrame() {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback()
  }
}

class Document extends EventTarget {
  media: Media[] = []
  fullscreenElement = null
  nextPlayError = false
  createElement(tag: string) {
    if (tag === 'video' || tag === 'audio') {
      const media = new Media(tag)
      if (this.nextPlayError) media.play.mockRejectedValue(new Error('autoplay denied'))
      this.media.push(media)
      return media
    }
    return new Element(tag)
  }
}

let dom: Document
let frames: Map<number, FrameRequestCallback>
let nextFrame: number

function parts(node: HTMLElement) {
  const root = node as unknown as Element
  return {
    poster: root.children.find((child) => child.tag === 'img'),
    feedback: root.children.find((child) => child.attributes.get('role') === 'status')!,
  }
}

function frame() {
  const callbacks = [...frames.values()]
  frames.clear()
  for (const callback of callbacks) callback(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  dom = new Document()
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('document', dom)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('canvas player presentation', () => {
  it('keeps the poster until an actual video frame is presented', () => {
    const player = createPlayer('video', '/video.mp4', { poster: '/poster.webp' })
    const media = dom.media[0]!
    const { poster, feedback } = parts(player.node)
    expect(media.style.opacity).toBe('0')
    expect(poster?.hidden).toBe(false)
    media.readyState = 2
    media.dispatchEvent(new Event('loadeddata'))
    media.dispatchEvent(new Event('playing'))
    expect(media.callbacks.size).toBe(1)
    expect(poster?.hidden).toBe(false)
    media.presentFrame()
    expect(poster?.hidden).toBe(true)
    expect(media.style.opacity).toBe('1')
    expect(feedback.style.display).toBe('none')
    player.dispose()
    expect(media.src).toBe('')
    expect(media.load).toHaveBeenCalledTimes(1)
  })

  it('shows an actionable error and can retry into a ready frame', () => {
    const player = createPlayer('video', '/video.mp4', { poster: '/poster.webp' })
    const media = dom.media[0]!
    const { poster, feedback } = parts(player.node)
    media.dispatchEvent(new Event('error'))
    const retry = feedback.children[1]!
    expect(retry.hidden).toBe(false)
    expect(feedback.children[0]!.textContent).toContain('暂时无法播放')
    expect(media.paused).toBe(true)
    retry.dispatchEvent(new Event('click'))
    expect(media.load).toHaveBeenCalledTimes(1)
    expect(media.play).toHaveBeenCalledTimes(2)
    expect(poster?.hidden).toBe(false)
    media.dispatchEvent(new Event('playing'))
    media.presentFrame()
    expect(feedback.style.display).toBe('none')
    player.dispose()
  })

  it('reports rejected playback and does not apply a late callback after disposal', async () => {
    dom.nextPlayError = true
    const rejected = createPlayer('audio', '/audio.mp3')
    await Promise.resolve()
    expect(parts(rejected.node).feedback.children[1]!.hidden).toBe(false)
    rejected.dispose()
    dom.nextPlayError = false
    const player = createPlayer('video', '/video.mp4', { poster: '/poster.webp' })
    const media = dom.media[1]!
    media.dispatchEvent(new Event('playing'))
    const late = [...media.callbacks.values()][0]!
    player.dispose()
    player.dispose()
    late()
    expect(parts(player.node).poster?.hidden).toBe(false)
    expect(media.callbacks.size).toBe(0)
    expect(media.load).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses a two-frame fallback when video frame callbacks are unavailable', () => {
    const player = createPlayer('video', '/video.mp4', { poster: '/poster.webp' })
    const media = dom.media[0]!
    Object.defineProperty(media, 'requestVideoFrameCallback', { value: undefined })
    media.readyState = 2
    media.dispatchEvent(new Event('loadeddata'))
    frame()
    expect(parts(player.node).poster?.hidden).toBe(false)
    frame()
    expect(parts(player.node).poster?.hidden).toBe(true)
    player.dispose()
    expect(frames.size).toBe(0)
  })

  it('readies audio without a video callback and shows buffering without resetting presentation', () => {
    const player = createPlayer('audio', '/audio.mp3')
    const media = dom.media[0]!
    media.dispatchEvent(new Event('playing'))
    const { feedback, poster } = parts(player.node)
    expect(poster).toBeUndefined()
    expect(feedback.style.display).toBe('none')
    media.dispatchEvent(new Event('waiting'))
    expect(feedback.children[0]!.textContent).toBe('正在缓冲…')
    media.dispatchEvent(new Event('playing'))
    expect(feedback.style.display).toBe('none')
    player.dispose()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { clock, type ClockSource, Playhead } from './playhead'

let frames: Map<number, FrameRequestCallback>
let nextFrame: number

function frame() {
  const ready = [...frames.values()]
  frames.clear()
  for (const draw of ready) draw(0)
}

function setup(total = 10) {
  let now = 0
  const clock: ClockSource = { now: () => now, resume: vi.fn() }
  const playhead = new Playhead()
  playhead.setClock(clock)
  playhead.setTotal(total)
  return {
    playhead,
    clock,
    advance: (seconds: number) => {
      now += seconds
    },
  }
}

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (draw: FrameRequestCallback) => {
    frames.set(++nextFrame, draw)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => vi.unstubAllGlobals())

describe('序列时间码', () => {
  it.each([
    [0, '0:00.0'],
    [-1, '0:00.0'],
    [59.94, '0:59.9'],
    [59.96, '1:00.0'],
    [1799.966666, '30:00.0'],
    [3599.999, '60:00.0'],
  ] as const)('显示 %s 秒时正确向分钟进位', (seconds, expected) => {
    expect(clock(seconds)).toBe(expected)
  })
})

describe('序列播放头', () => {
  it('按时钟推进；逐帧通知不重新排声音，暂停取当前时刻并取消下一帧', () => {
    const { playhead, advance, clock } = setup()
    const render = vi.fn()
    const transport = vi.fn()
    playhead.subscribe(render)
    playhead.onTransport(transport)
    playhead.play()
    playhead.play()
    expect(clock.resume).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    advance(0.5)
    frame()
    expect(playhead.t).toBe(0.5)
    expect(render).toHaveBeenCalledTimes(2)
    expect(transport).toHaveBeenCalledTimes(1)
    advance(0.25)
    playhead.pause()
    expect(playhead.t).toBe(0.75)
    expect(playhead.playing).toBe(false)
    expect(frames.size).toBe(0)
    expect(transport).toHaveBeenCalledTimes(2)
    advance(1)
    expect(playhead.position()).toBe(0.75)
  })

  it('音频时钟挂起或恢复时保留两帧之间已经经过的播放时间', () => {
    const { playhead, advance } = setup()
    playhead.play()
    advance(0.3)
    frame()
    advance(0.2)
    let audioNow = 100
    playhead.setClock({ now: () => audioNow })
    expect(playhead.t).toBeCloseTo(0.5)
    expect(playhead.position()).toBeCloseTo(0.5)
    audioNow += 0.4
    frame()
    expect(playhead.t).toBeCloseTo(0.9)
    playhead.dispose()
  })

  it('跳转限制在成片内；到结尾只通知一次并停下，再播放从头开始', () => {
    const { playhead, advance } = setup(2)
    playhead.seek(-1)
    expect(playhead.t).toBe(0)
    playhead.seek(5)
    expect(playhead.t).toBe(2)
    playhead.play()
    expect(playhead.t).toBe(0)
    const transport = vi.fn()
    playhead.onTransport(transport)
    advance(3)
    frame()
    expect(playhead.t).toBe(2)
    expect(playhead.playing).toBe(false)
    expect(frames.size).toBe(0)
    expect(transport).toHaveBeenCalledTimes(1)
    playhead.play()
    expect(playhead.t).toBe(0)
    playhead.dispose()
  })

  it('缩短成片会收回播放头，退订和销毁后不再通知或留逐帧任务', () => {
    const { playhead } = setup()
    playhead.seek(8)
    playhead.setTotal(3)
    expect(playhead.t).toBe(3)
    const render = vi.fn()
    const transport = vi.fn()
    const offRender = playhead.subscribe(render)
    const offTransport = playhead.onTransport(transport)
    offRender()
    offTransport()
    playhead.play()
    expect(render).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
    playhead.subscribe(render)
    playhead.onTransport(transport)
    playhead.dispose()
    expect(frames.size).toBe(0)
    expect(playhead.playing).toBe(false)
    playhead.seek(1)
    expect(render).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
  })

  it('没有可播放时长时不安排帧或恢复时钟', () => {
    const { playhead, clock } = setup(0)
    playhead.play()
    expect(playhead.playing).toBe(false)
    expect(clock.resume).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })
})

import { useSyncExternalStore } from 'react'

/** 时间来源：默认是页面时钟；预览引擎接管时换成音频时钟，画面跟着声音走 */
export interface ClockSource {
  /** 当前时刻（秒），单调递增 */
  now(): number
  /** 开始播放前调用（比如恢复 AudioContext） */
  resume?(): void
}

const pageClock: ClockSource = { now: () => performance.now() / 1000 }

/**
 * 序列的播放头：时间线、预览、快捷键共用一个。
 * 播放时每帧通知订阅者；时间线的播放头直接改 DOM，不让整棵 React 树每帧重渲染。
 */
export class Playhead {
  t = 0
  playing = false
  total = 0
  private listeners = new Set<() => void>()
  /** 播放、暂停、跳转时通知（播放中的逐帧推进不算），声音据此重新排程 */
  private transports = new Set<() => void>()
  private raf = 0
  /** 播放开始时的时钟读数和播放头位置 */
  private base = { clock: 0, t: 0 }
  private clock: ClockSource = pageClock

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  onTransport = (fn: () => void) => {
    this.transports.add(fn)
    return () => {
      this.transports.delete(fn)
    }
  }

  private emit(transport = false) {
    if (transport) for (const fn of this.transports) fn()
    for (const fn of this.listeners) fn()
  }

  setClock(clock: ClockSource | null) {
    const t = this.position()
    this.t = t
    this.clock = clock ?? pageClock
    this.base = { clock: this.clock.now(), t }
  }

  setTotal(total: number) {
    if (total === this.total) return
    this.total = total
    if (this.t > total) this.seek(total)
  }

  seek(t: number) {
    this.t = Math.min(Math.max(0, t), this.total)
    this.base = { clock: this.clock.now(), t: this.t }
    this.emit(true)
  }

  play() {
    if (this.playing || this.total <= 0) return
    if (this.t >= this.total - 0.01) this.t = 0
    this.clock.resume?.()
    this.playing = true
    this.base = { clock: this.clock.now(), t: this.t }
    this.raf = requestAnimationFrame(this.tick)
    this.emit(true)
  }

  pause() {
    if (!this.playing) return
    cancelAnimationFrame(this.raf)
    this.t = this.position()
    this.playing = false
    this.emit(true)
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  /** 播放中按时钟推算的位置 */
  position() {
    if (!this.playing) return this.t
    return Math.min(this.total, this.base.t + this.clock.now() - this.base.clock)
  }

  private tick = () => {
    const t = this.position()
    if (t >= this.total) {
      this.t = this.total
      this.playing = false
      this.emit(true)
      return
    }
    this.t = t
    this.emit()
    this.raf = requestAnimationFrame(this.tick)
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.playing = false
    this.listeners.clear()
    this.transports.clear()
  }
}

export const usePlaying = (p: Playhead) => useSyncExternalStore(p.subscribe, () => p.playing)

/** 0:03.4 这样的时间 */
export const clock = (t: number) => {
  const s = Math.max(0, t)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

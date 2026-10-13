import type { Timeline } from '@plein/nodes'
import { ALL_FORMATS, CanvasSink, Input, UrlSource, type WrappedCanvas } from 'mediabunny'
import { assetUrls } from '../../api/client'
import type { ClockSource, Playhead } from './playhead'

/** 一段画面：在成片的 start 处出现，播放素材 in 起的 length 秒；没有素材（还没生成）时是黑场 */
export interface SceneClip {
  /** 同一素材在序列里出现多次时各自独立解码 */
  key: string
  assetId?: string
  start: number
  length: number
  in: number
}

/** 一段声音：成片 start 处开始，从素材 offset 起播 duration 秒 */
export interface SceneSound {
  assetId: string
  start: number
  offset: number
  duration: number
  gain: number
  loop?: boolean
  /** 音量包络（成片时间，倍数），点之间线性；第一个点之前取第一个值，最后一个点之后取最后一个值 */
  envelope?: Array<[number, number]>
}

export interface Scene {
  width: number
  height: number
  total: number
  clips: SceneClip[]
  sounds: SceneSound[]
  transition: Timeline['transition']
}

/** 预览画布长边上限：再大肉眼看不出，解码和合成的开销却翻倍 */
const MAX_SIDE = 1280
/** 下一段开始前多久预先把解码器起起来 */
const PREROLL = 0.6
const FRAME = 1 / 30

export function previewSize(width: number, height: number) {
  const k = Math.min(1, MAX_SIDE / Math.max(width, height))
  return { width: Math.round(width * k), height: Math.round(height * k) }
}

/** 某个时刻的包络值 */
export function envelopeAt(env: SceneSound['envelope'], x: number) {
  if (!env?.length) return 1
  if (x <= env[0]![0]) return env[0]![1]
  for (let i = 1; i < env.length; i++) {
    const [x1, v1] = env[i]!
    if (x <= x1) {
      const [x0, v0] = env[i - 1]!
      return x1 > x0 ? v0 + ((v1 - v0) * (x - x0)) / (x1 - x0) : v1
    }
  }
  return env.at(-1)![1]
}

/** 一段画面的帧来源 */
interface Frames {
  readonly kind: 'webcodecs' | 'element'
  /** 对齐到素材时间 mt；播放中连续出帧，暂停时取精确的那一帧 */
  update(mt: number, playing: boolean): void
  /** 不在画面上：停掉解码，释放资源 */
  park(): void
  image(): { source: CanvasImageSource; width: number; height: number } | null
  dispose(): void
}

/**
 * 用 Mediabunny（WebCodecs）解码：画面按播放头逐帧取，暂停、逐帧、拖动都能拿到精确的帧，
 * 不受 video 元素 seek 精度和缓冲策略影响。
 */
class CodecFrames implements Frames {
  readonly kind = 'webcodecs'
  private input: Input
  private sink: CanvasSink | null = null
  private first = 0
  private cur: WrappedCanvas | null = null
  private next: WrappedCanvas | null = null
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null
  private want = 0
  private mode: 'play' | 'still' | 'parked' = 'parked'
  /** 每次重起迭代器或换模式加一，旧的异步任务看到不一致就退出 */
  private gen = 0
  private pumping = -1
  /** 迭代器刚重起：第一帧直接用，不等播放头 */
  private fresh = false
  private stillBusy = false
  private stillDone = Number.NaN

  constructor(
    url: string,
    box: { width: number; height: number },
    private onFrame: () => void,
    onFail: () => void,
  ) {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    this.input = input
    void (async () => {
      const track = await input.getPrimaryVideoTrack()
      if (!track || !(await track.canDecode())) throw new Error('浏览器解不了这个视频')
      this.first = await track.getFirstTimestamp()
      this.sink = new CanvasSink(track, { ...box, fit: 'contain', poolSize: 4 })
      this.restart()
    })().catch((err) => {
      console.warn('[预览] WebCodecs 解码不可用，退回 video 元素：', err)
      onFail()
    })
  }

  update(mt: number, playing: boolean) {
    this.want = mt
    if (playing) {
      const cur = this.cur
      const lost =
        this.mode !== 'play' ||
        (cur && mt < cur.timestamp - this.first - 0.05) ||
        (this.next && mt > this.next.timestamp - this.first + 0.5)
      if (lost) {
        this.mode = 'play'
        this.restart()
      } else this.pump()
    } else {
      if (this.mode !== 'still') {
        this.mode = 'still'
        this.stop()
      }
      this.still()
    }
  }

  park() {
    if (this.mode === 'parked') return
    this.mode = 'parked'
    this.stop()
  }

  image() {
    const c = this.cur?.canvas
    return c ? { source: c, width: c.width, height: c.height } : null
  }

  dispose() {
    this.park()
    this.input.dispose()
  }

  private stop() {
    this.gen++
    void this.iter?.return().catch(() => {})
    this.iter = null
    this.cur = null
    this.next = null
    this.stillDone = Number.NaN
  }

  private restart() {
    if (!this.sink) return
    if (this.mode === 'still') return this.still()
    if (this.mode !== 'play') return
    this.stop()
    this.iter = this.sink.canvases(this.first + Math.max(0, this.want))
    this.fresh = true
    this.pump()
  }

  /** 播放：手里留一帧“下一帧”，播放头越过它就换上，再去取下一帧 */
  private pump() {
    const gen = this.gen
    const iter = this.iter
    if (!iter || this.pumping === gen) return
    this.pumping = gen
    void (async () => {
      while (gen === this.gen) {
        const want = this.first + this.want
        if (this.next && (this.next.timestamp <= want || this.fresh)) {
          this.cur = this.next
          this.next = null
          this.fresh = false
          this.onFrame()
          continue
        }
        if (this.next) break
        const r = await iter.next()
        if (gen !== this.gen || r.done) break
        this.next = r.value
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.pumping === gen) this.pumping = -1
      })
  }

  /** 暂停：取正好那一帧；拖动时只取最新请求的位置 */
  private still() {
    const sink = this.sink
    if (!sink || this.stillBusy || this.stillDone === this.want) return
    this.stillBusy = true
    const gen = this.gen
    void (async () => {
      while (gen === this.gen && this.mode === 'still' && this.stillDone !== this.want) {
        const want = this.want
        const frame = await sink.getCanvas(this.first + Math.max(0, want))
        if (gen !== this.gen) break
        this.stillDone = want
        if (frame) {
          this.cur = frame
          this.onFrame()
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        this.stillBusy = false
      })
  }
}

/** WebCodecs 不可用（或编码不支持）时的退路：一个不挂到页面上的 video 元素跟着时钟走 */
class ElementFrames implements Frames {
  readonly kind = 'element'
  private el = document.createElement('video')

  constructor(url: string, onFrame: () => void) {
    const el = this.el
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.src = url
    el.addEventListener('seeked', onFrame)
    el.addEventListener('loadeddata', onFrame)
  }

  update(mt: number, playing: boolean) {
    const el = this.el
    if (
      Math.abs(el.currentTime - mt) > 0.25 ||
      (!playing && Math.abs(el.currentTime - mt) > 0.01)
    ) {
      try {
        el.currentTime = Math.max(0, mt)
      } catch {}
    }
    if (playing && el.paused) void el.play().catch(() => {})
    if (!playing && !el.paused) el.pause()
  }

  park() {
    if (!this.el.paused) this.el.pause()
  }

  image() {
    const el = this.el
    return el.readyState >= 2 && el.videoWidth
      ? { source: el, width: el.videoWidth, height: el.videoHeight }
      : null
  }

  dispose() {
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
  }
}

/**
 * 序列预览引擎：画面用 WebCodecs 逐帧解码画到一块画布上（叠化、经黑场都在这里合成），
 * 声音全部解码成 AudioBuffer 用 Web Audio 按成片时间排程，音频时钟就是播放头的时钟，
 * 声画不会各走各的。WebCodecs 不可用时画面退回 video 元素，声音照旧。
 */
export class PreviewEngine {
  private canvas: HTMLCanvasElement | null = null
  private g: CanvasRenderingContext2D | null = null
  private scene: Scene = { width: 0, height: 0, total: 0, clips: [], sounds: [], transition: null }
  private frames = new Map<string, Frames>()
  private audio: AudioContext | null = null
  private master: GainNode | null = null
  private buffers = new Map<string, Promise<AudioBuffer | null>>()
  private playing = new Set<AudioBufferSourceNode>()
  private soundsKey = ''
  private gen = 0
  private off: Array<() => void> = []
  private clock: ClockSource | null = null

  constructor(private playhead: Playhead) {
    this.off.push(playhead.subscribe(this.render), playhead.onTransport(this.transport))
    if (typeof AudioContext !== 'undefined') {
      const ctx = new AudioContext({ latencyHint: 'interactive' })
      this.audio = ctx
      this.master = ctx.createGain()
      this.master.connect(ctx.destination)
      const clock: ClockSource = { now: () => ctx.currentTime }
      this.clock = clock
      // 音频跑起来以后播放头改用音频时钟；被浏览器挂起时退回页面时钟，画面照样走
      const sync = () => {
        playhead.setClock(ctx.state === 'running' ? clock : null)
        this.restartAudio()
      }
      ctx.addEventListener('statechange', sync)
      this.off.push(() => ctx.removeEventListener('statechange', sync))
    }
  }

  attach(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas
    this.g = canvas?.getContext('2d', { alpha: false }) ?? null
    this.resize()
    this.render()
  }

  setScene(scene: Scene) {
    const resized = scene.width !== this.scene.width || scene.height !== this.scene.height
    this.scene = scene
    if (resized) {
      // 画布尺寸变了，解码器输出尺寸也要跟着换
      for (const f of this.frames.values()) f.dispose()
      this.frames.clear()
      this.resize()
    }
    const keep = new Set(scene.clips.filter((c) => c.assetId).map((c) => c.key))
    for (const [key, f] of this.frames) {
      if (!keep.has(key)) {
        f.dispose()
        this.frames.delete(key)
      }
    }
    const soundsKey = JSON.stringify(scene.sounds)
    if (soundsKey !== this.soundsKey) {
      this.soundsKey = soundsKey
      this.restartAudio()
    }
    this.render()
  }

  dispose() {
    for (const off of this.off) off()
    this.stopAudio()
    for (const f of this.frames.values()) f.dispose()
    this.frames.clear()
    if (this.clock) this.playhead.setClock(null)
    void this.audio?.close().catch(() => {})
  }

  private resize() {
    const c = this.canvas
    if (!c || !this.scene.width) return
    const { width, height } = previewSize(this.scene.width, this.scene.height)
    if (c.width !== width) c.width = width
    if (c.height !== height) c.height = height
  }

  private framesFor(clip: SceneClip): Frames | null {
    if (!clip.assetId) return null
    let f = this.frames.get(clip.key)
    if (!f) {
      const url = assetUrls.original(clip.assetId)
      const created: Frames =
        typeof VideoDecoder === 'undefined'
          ? new ElementFrames(url, this.render)
          : new CodecFrames(
              url,
              previewSize(this.scene.width, this.scene.height),
              this.render,
              () => {
                // 解不了：换成 video 元素（这段已经被换掉或删掉就算了）
                if (this.frames.get(clip.key) !== created) return
                created.dispose()
                this.frames.set(clip.key, new ElementFrames(url, this.render))
                this.render()
              },
            )
      f = created
      this.frames.set(clip.key, f)
    }
    return f
  }

  /** 画当前时刻：黑底，叠化时后一段按进度渐显，经黑场时压一层黑 */
  private render = () => {
    const g = this.g
    const c = this.canvas
    if (!g || !c) return
    const { clips, total, transition } = this.scene
    const t = this.playhead.t
    const playing = this.playhead.playing
    const real = clips.filter((x) => x.length > 0)
    let active = real.filter((x) => t >= x.start && t < x.start + x.length)
    // 停在结尾时显示最后一段的最后一帧
    if (!active.length && total > 0 && t >= total && real.length) active = [real.at(-1)!]
    const local = (x: SceneClip) => Math.min(Math.max(0, t - x.start), x.length - FRAME)

    for (const clip of clips) {
      const on = active.includes(clip)
      const soon = playing && clip.length > 0 && clip.start > t && clip.start - t < PREROLL
      if (!on && !soon) {
        this.frames.get(clip.key)?.park()
        continue
      }
      const f = this.framesFor(clip)
      if (!f) continue
      if (on) f.update(clip.in + local(clip), playing)
      // 快到的下一段先起解码器，切过去的那一帧不用等
      else f.update(clip.in, true)
    }

    const layers = active.map((clip) => ({ clip, image: this.frames.get(clip.key)?.image() }))
    const kinds = new Set(
      layers.flatMap((l) => (l.clip.assetId ? [this.frames.get(l.clip.key)!.kind] : [])),
    )
    c.dataset.decoder = [...kinds].join(' ')
    // 有素材的画面还没解出来：保留上一帧，别闪黑
    if (layers.some((l) => l.clip.assetId && !l.image)) return

    g.globalAlpha = 1
    g.fillStyle = '#000'
    g.fillRect(0, 0, c.width, c.height)
    const firstReal = real[0]
    const lastReal = real.at(-1)
    let black = 0
    for (const { clip, image } of layers) {
      let alpha = 1
      if (
        transition?.type === 'dissolve' &&
        clip !== firstReal &&
        t < clip.start + transition.duration
      )
        alpha = Math.max(0, (t - clip.start) / transition.duration)
      if (transition?.type === 'fade') {
        const half = transition.duration / 2
        if (clip !== firstReal && t - clip.start < half)
          black = Math.max(black, 1 - (t - clip.start) / half)
        const left = clip.start + clip.length - t
        if (clip !== lastReal && left < half) black = Math.max(black, 1 - left / half)
      }
      if (!image) continue
      const k = Math.min(c.width / image.width, c.height / image.height)
      const w = image.width * k
      const h = image.height * k
      g.globalAlpha = alpha
      g.drawImage(image.source, (c.width - w) / 2, (c.height - h) / 2, w, h)
    }
    if (black > 0) {
      g.globalAlpha = Math.min(1, black)
      g.fillRect(0, 0, c.width, c.height)
    }
    g.globalAlpha = 1
  }

  private transport = () => {
    // 播放要在用户手势里恢复音频；恢复后 statechange 会换时钟、重新排程
    if (this.playhead.playing && this.audio?.state === 'suspended') void this.audio.resume()
    this.restartAudio()
    this.render()
  }

  private stopAudio() {
    this.gen++
    for (const s of this.playing) {
      try {
        s.stop()
      } catch {}
      s.disconnect()
    }
    this.playing.clear()
  }

  private restartAudio() {
    this.stopAudio()
    const ctx = this.audio
    if (!this.playhead.playing || !ctx || ctx.state !== 'running') return
    const gen = this.gen
    for (const s of this.scene.sounds) void this.schedule(s, gen)
  }

  private buffer(assetId: string) {
    let p = this.buffers.get(assetId)
    if (!p) {
      const ctx = this.audio!
      p = fetch(assetUrls.original(assetId))
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => ctx.decodeAudioData(b))
        // 没有声轨的视频解不出来，当作静音
        .catch(() => null)
      this.buffers.set(assetId, p)
    }
    return p
  }

  /** 从播放头当前位置起排一段声音；还没解码完的解完再排，按那时的位置补上进度 */
  private async schedule(s: SceneSound, gen: number) {
    const buf = await this.buffer(s.assetId)
    const ctx = this.audio
    if (!buf || !ctx || !this.master || gen !== this.gen) return
    const now = ctx.currentTime
    const t = this.playhead.position()
    const end = Math.min(s.start + s.duration, this.scene.total)
    if (end <= t) return
    const delay = Math.max(0, s.start - t)
    let offset = s.offset + Math.max(0, t - s.start)
    if (s.loop) offset %= buf.duration
    else if (offset >= buf.duration) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = !!s.loop
    const gain = ctx.createGain()
    const from = t + delay
    gain.gain.setValueAtTime(s.gain * envelopeAt(s.envelope, from), now + delay)
    for (const [x, v] of s.envelope ?? [])
      if (x > from && x <= end) gain.gain.linearRampToValueAtTime(s.gain * v, now + (x - t))
    src.connect(gain).connect(this.master)
    src.start(now + delay, offset)
    src.stop(now + (end - t))
    src.addEventListener('ended', () => {
      this.playing.delete(src)
      gain.disconnect()
    })
    this.playing.add(src)
  }
}

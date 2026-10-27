import { type ComposeTransition, overlapping } from '@plein/plugin-sdk'
import { ALL_FORMATS, CanvasSink, Input, UrlSource, type WrappedCanvas } from 'mediabunny'
import { assetUrls } from '../../api/client'
import type { ClockSource, Playhead } from './playhead'

/** 一段画面：在成片的 start 处出现，播放素材 in 起的 length 秒；没有素材（还没生成）时是黑场 */
export interface SceneClip {
  /** 同一素材在序列里出现多次时各自独立解码 */
  key: string
  assetId?: string
  kind?: 'image' | 'video'
  start: number
  length: number
  in: number
  /** 播放速度：素材时间 = in + 成片里过去的时间 × speed */
  speed: number
  /** 从上一段切进来的转场（和导出同一份） */
  transition?: ComposeTransition
  /** WebM alpha 只能走原生元素；WebCodecs/CanvasSink可能丢失透明通道。 */
  native?: boolean
  seekOnly?: boolean
}

export interface SceneOverlay extends SceneClip {
  id: string
  x: number
  y: number
  width: number
  height: number
  opacity: number
}

/** 一段声音：成片 start 处开始，从素材 offset 起播 duration 秒 */
export interface SceneSound {
  assetId: string
  start: number
  offset: number
  duration: number
  gain: number
  loop?: boolean
  /** 播放速率（变速镜头的原声）；Web Audio 变速会变调，导出时不变调 */
  rate?: number
  /** 音量包络（成片时间，倍数），点之间线性；第一个点之前取第一个值，最后一个点之后取最后一个值 */
  envelope?: Array<[number, number]>
}

export interface Scene {
  width: number
  height: number
  total: number
  clips: SceneClip[]
  sounds: SceneSound[]
  overlays?: SceneOverlay[]
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

function smoothstep(e0: number, e1: number, x: number) {
  const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return k * k * (3 - 2 * k)
}

/** 等比缩放居中画进 w × h，dx 是整体水平偏移 */
function drawContain(
  g: CanvasRenderingContext2D,
  image: { source: CanvasImageSource; width: number; height: number },
  w: number,
  h: number,
  dx: number,
) {
  const k = Math.min(w / image.width, h / image.height)
  const iw = image.width * k
  const ih = image.height * k
  g.drawImage(image.source, dx + (w - iw) / 2, (h - ih) / 2, iw, ih)
}

/** 一段画面的帧来源 */
interface Frames {
  readonly kind: 'webcodecs' | 'element' | 'image'
  /** 对齐到素材时间 mt；播放中连续出帧，暂停时取精确的那一帧；rate 是播放速度 */
  update(mt: number, playing: boolean, rate: number): void
  /** 不在画面上：停掉解码，释放资源 */
  park(): void
  image(): { source: CanvasImageSource; width: number; height: number } | null
  dispose(): void
}

class ImageFrames implements Frames {
  readonly kind = 'image'
  private el = new Image()
  constructor(url: string, onFrame: () => void, onFail: () => void) {
    this.el.onerror = onFail
    this.el.onload = onFrame
    this.el.src = url
  }
  update() {}
  park() {}
  image() {
    return this.el.complete && this.el.naturalWidth
      ? { source: this.el, width: this.el.naturalWidth, height: this.el.naturalHeight }
      : null
  }
  dispose() {
    this.el.onload = null
    this.el.onerror = null
    this.el.src = ''
  }
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
  private disposed = false

  constructor(
    url: string,
    box: { width: number; height: number },
    private onFrame: () => void,
    private onFail: () => void,
  ) {
    const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS })
    this.input = input
    void (async () => {
      const track = await input.getPrimaryVideoTrack()
      if (this.disposed) return
      if (!track) throw new Error('浏览器解不了这个视频')
      const canDecode = await track.canDecode()
      if (this.disposed) return
      if (!canDecode) throw new Error('浏览器解不了这个视频')
      const first = await track.getFirstTimestamp()
      if (this.disposed) return
      this.first = first
      this.sink = new CanvasSink(track, { ...box, fit: 'contain', poolSize: 4 })
      this.restart()
    })().catch((err) => this.fail(err))
  }

  private fail(error: unknown, gen = this.gen) {
    if (this.disposed || gen !== this.gen) return
    console.warn('[预览] WebCodecs 解码不可用，退回 video 元素：', error)
    this.onFail()
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
    if (this.disposed) return
    this.disposed = true
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
      .catch((err) => this.fail(err, gen))
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
    let requested = this.want
    void (async () => {
      while (gen === this.gen && this.mode === 'still' && this.stillDone !== this.want) {
        const want = this.want
        requested = want
        const frame = await sink.getCanvas(this.first + Math.max(0, want))
        if (gen !== this.gen) break
        if (want !== this.want) continue
        this.stillDone = want
        if (frame) {
          this.cur = frame
          this.onFrame()
        }
      }
    })()
      .catch((err) => {
        if (requested === this.want) this.fail(err, gen)
      })
      .finally(() => {
        this.stillBusy = false
        // 旧读取占用期间的新暂停位置不能等下一次交互才补发。
        if (
          !this.disposed &&
          this.mode === 'still' &&
          (gen !== this.gen || requested !== this.want)
        )
          this.still()
      })
  }
}

/** WebCodecs 不可用（或编码不支持）时的退路：一个不挂到页面上的 video 元素跟着时钟走 */
class ElementFrames implements Frames {
  readonly kind = 'element'
  private el = document.createElement('video')
  private want = 0
  private parked = true
  private frozen: OffscreenCanvas | null = null

  constructor(
    url: string,
    private onFrame: () => void,
    onFail: () => void,
    private seekOnly = false,
  ) {
    const el = this.el
    el.onerror = onFail
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.src = url
    el.addEventListener('seeked', this.settled)
    el.addEventListener('loadeddata', this.settled)
  }

  update(mt: number, playing: boolean, rate: number) {
    const el = this.el
    this.want = Math.max(0, mt)
    this.parked = false
    if (this.seekOnly) {
      el.pause()
      this.seekLatest()
      return
    }
    if (el.playbackRate !== rate) el.playbackRate = rate
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

  private seekLatest() {
    if (!this.el.seeking && Math.abs(this.el.currentTime - this.want) > 0.001) {
      try {
        this.el.currentTime = this.want
      } catch {}
    }
  }
  private settled = () => {
    const el = this.el
    if (
      this.seekOnly &&
      typeof OffscreenCanvas !== 'undefined' &&
      el.readyState >= 2 &&
      el.videoWidth &&
      !el.seeking
    ) {
      this.frozen ??= new OffscreenCanvas(el.videoWidth, el.videoHeight)
      if (this.frozen.width !== el.videoWidth) this.frozen.width = el.videoWidth
      if (this.frozen.height !== el.videoHeight) this.frozen.height = el.videoHeight
      const g = this.frozen.getContext('2d')!
      g.clearRect(0, 0, this.frozen.width, this.frozen.height)
      g.drawImage(el, 0, 0)
    }
    if (this.seekOnly && !this.parked) this.seekLatest()
    this.onFrame()
  }

  park() {
    this.parked = true
    if (!this.el.paused) this.el.pause()
  }

  image() {
    const el = this.el
    if (this.seekOnly && this.frozen)
      return { source: this.frozen, width: this.frozen.width, height: this.frozen.height }
    return !el.seeking && el.readyState >= 2 && el.videoWidth
      ? { source: el, width: el.videoWidth, height: el.videoHeight }
      : null
  }

  dispose() {
    this.parked = true
    if (this.frozen) {
      this.frozen.width = 0
      this.frozen.height = 0
      this.frozen = null
    }
    this.el.pause()
    this.el.onerror = null
    this.el.removeEventListener('seeked', this.settled)
    this.el.removeEventListener('loadeddata', this.settled)
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
  private scene: Scene = { width: 0, height: 0, total: 0, clips: [], sounds: [] }
  private frames = new Map<string, Frames>()
  private nativeFrames = new Set<string>()
  private audio: AudioContext | null = null
  private master: GainNode | null = null
  private buffers = new Map<string, Promise<AudioBuffer | null>>()
  private audioRequests = new Map<string, AbortController>()
  private playing = new Set<AudioBufferSourceNode>()
  private soundsKey = ''
  private gen = 0
  private off: Array<() => void> = []
  private clock: ClockSource | null = null

  private disposed = false
  private failedFrames = new Set<string>()
  private failedSounds = new Set<string>()
  private issueCount = 0

  constructor(
    private playhead: Playhead,
    private onIssues: (count: number) => void = () => {},
  ) {
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
      this.nativeFrames.clear()
      this.resize()
    }
    const visuals = [...scene.clips, ...(scene.overlays ?? [])]
    const keep = new Set(visuals.filter((c) => c.assetId).map((c) => c.key))
    for (const [key, f] of this.frames) {
      if (!keep.has(key)) {
        f.dispose()
        this.frames.delete(key)
        this.nativeFrames.delete(key)
      }
    }
    for (const key of this.failedFrames) if (!keep.has(key)) this.failedFrames.delete(key)
    const sounds = new Set(scene.sounds.map((s) => s.assetId))
    // 移出的来源释放缓存（包括失败和读取中的 Promise）；恢复后要重新读取，
    // 旧请求的回调也不能把错误写进恢复后的同一素材。
    for (const id of this.buffers.keys()) {
      if (sounds.has(id)) continue
      this.buffers.delete(id)
      this.audioRequests.get(id)?.abort()
      this.audioRequests.delete(id)
    }
    for (const id of this.failedSounds) if (!sounds.has(id)) this.failedSounds.delete(id)
    this.reportIssues()
    const soundsKey = JSON.stringify(scene.sounds)
    if (soundsKey !== this.soundsKey) {
      this.soundsKey = soundsKey
      this.restartAudio()
    }
    this.render()
  }

  dispose() {
    this.disposed = true
    for (const off of this.off) off()
    this.stopAudio()
    for (const request of this.audioRequests.values()) request.abort()
    this.audioRequests.clear()
    this.buffers.clear()
    for (const f of this.frames.values()) f.dispose()
    this.frames.clear()
    this.nativeFrames.clear()
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

  /** 只重新加载失败的来源；已成功解码的素材和当前播放位置保留。 */
  retryFailed() {
    if (this.disposed) return
    const frames = new Set(this.failedFrames)
    const sounds = [...this.failedSounds]
    this.failedFrames.clear()
    this.failedSounds.clear()
    for (const key of frames) {
      this.frames.get(key)?.dispose()
      this.frames.delete(key)
      this.nativeFrames.delete(key)
    }
    for (const id of sounds) this.buffers.delete(id)
    this.reportIssues()
    for (const clip of [...this.scene.clips, ...(this.scene.overlays ?? [])])
      if (frames.has(clip.key)) this.framesFor(clip)?.update(clip.in, false, clip.speed)
    for (const id of sounds) void this.buffer(id)
    this.render()
  }

  private reportIssues() {
    if (this.disposed) return
    const count = this.failedFrames.size + this.failedSounds.size
    if (count === this.issueCount) return
    this.issueCount = count
    this.onIssues(count)
  }

  private framesFor(clip: SceneClip): Frames | null {
    if (!clip.assetId) return null
    const existing = this.frames.get(clip.key)
    if (
      existing &&
      !(clip.native && existing.kind === 'webcodecs') &&
      !(!clip.native && this.nativeFrames.has(clip.key))
    )
      return existing
    existing?.dispose()
    this.nativeFrames.delete(clip.key)
    const url = assetUrls.original(clip.assetId)
    const ready = (frame: Frames) => {
      if (this.disposed || this.frames.get(clip.key) !== frame) return
      if (frame.image()) this.failedFrames.delete(clip.key)
      this.reportIssues()
      this.render()
    }
    const fail = (frame: Frames) => {
      if (this.disposed || this.frames.get(clip.key) !== frame) return
      this.failedFrames.add(clip.key)
      this.reportIssues()
      this.playhead.pause()
    }
    const element = () => {
      const frame: Frames = new ElementFrames(
        url,
        () => ready(frame),
        () => fail(frame),
        clip.seekOnly,
      )
      return frame
    }
    let created: Frames
    if (clip.kind === 'image') {
      const frame: Frames = new ImageFrames(
        url,
        () => ready(frame),
        () => fail(frame),
      )
      created = frame
    } else if (clip.native || typeof VideoDecoder === 'undefined') created = element()
    else {
      const frame: Frames = new CodecFrames(
        url,
        previewSize(this.scene.width, this.scene.height),
        () => ready(frame),
        () => {
          if (this.disposed || this.frames.get(clip.key) !== frame) return
          frame.dispose()
          this.frames.set(clip.key, element())
          this.render()
        },
      )
      created = frame
    }
    this.frames.set(clip.key, created)
    if (clip.native && created.kind === 'element') this.nativeFrames.add(clip.key)
    return created
  }

  /**
   * 画当前时刻：黑底上按顺序画正在画面上的各段，转场和导出的 xfade 同一套算法：
   * 叠化渐显、划像从右往左擦出、推移从右侧推入、闪白先白后显，经黑场压一层黑。
   */
  private render = () => {
    const g = this.g
    const c = this.canvas
    if (!g || !c) return
    const { clips, total } = this.scene
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
      if (on) f.update(clip.in + local(clip) * clip.speed, playing, clip.speed)
      // 快到的下一段先起解码器，切过去的那一帧不用等
      else f.update(clip.in, true, clip.speed)
    }

    const overlays = this.scene.overlays ?? []
    const activeOverlays = overlays.filter(
      (overlay) => t >= overlay.start && t < overlay.start + overlay.length,
    )
    for (const overlay of overlays) {
      if (!activeOverlays.includes(overlay)) {
        this.frames.get(overlay.key)?.park()
        continue
      }
      this.framesFor(overlay)?.update(
        overlay.in + Math.max(0, t - overlay.start) * overlay.speed,
        playing,
        overlay.speed,
      )
    }
    c.dataset.overlayDecoder = activeOverlays
      .map((overlay) => this.frames.get(overlay.key)?.kind ?? '')
      .join(' ')

    const layers = active.map((clip) => ({
      clip,
      image: this.frames.get(clip.key)?.image(),
      dx: 0,
      x0: 0,
      alpha: 1,
      flash: -1,
    }))
    const kinds = new Set(
      layers.flatMap((l) => (l.clip.assetId ? [this.frames.get(l.clip.key)!.kind] : [])),
    )
    c.dataset.decoder = [...kinds].join(' ')
    // 有素材的画面还没解出来：保留上一帧，别闪黑
    if (layers.some((l) => l.clip.assetId && !l.image)) return

    const W = c.width
    const H = c.height
    let black = 0
    layers.forEach((l, i) => {
      const { clip } = l
      const tr = clip.transition
      if (tr?.type === 'fade' && t - clip.start < tr.duration / 2)
        black = Math.max(black, 1 - (t - clip.start) / (tr.duration / 2))
      const next = real[real.indexOf(clip) + 1]?.transition
      const left = clip.start + clip.length - t
      if (next?.type === 'fade' && left < next.duration / 2)
        black = Math.max(black, 1 - left / (next.duration / 2))
      if (i === 0 || !tr || !overlapping(tr) || t >= clip.start + tr.duration) return
      const p = Math.min(1, Math.max(0, (t - clip.start) / tr.duration))
      if (tr.type === 'dissolve') l.alpha = p
      else if (tr.type === 'wipe') l.x0 = W * (1 - p)
      else if (tr.type === 'slide') {
        l.dx = W * (1 - p)
        layers[i - 1]!.dx = -W * p
      } else if (tr.type === 'flash') l.flash = p
    })

    g.globalAlpha = 1
    g.fillStyle = '#000'
    g.fillRect(0, 0, W, H)
    for (const l of layers) {
      if (!l.image) continue
      if (l.flash >= 0) {
        // xfade fadewhite：A' = A 混白（前 20% 变白），B' = 白混 B，再按进度在两者间叠化
        const q = 1 - l.flash
        g.globalAlpha = 1 - smoothstep(0.8, 1, q)
        g.fillStyle = '#fff'
        g.fillRect(0, 0, W, H)
        const scratch = this.scratchFor(W, H)
        const sg = scratch.getContext('2d')!
        sg.globalAlpha = 1
        sg.fillStyle = '#000'
        sg.fillRect(0, 0, W, H)
        drawContain(sg, l.image, W, H, 0)
        sg.globalAlpha = smoothstep(0.2, 1, q)
        sg.fillStyle = '#fff'
        sg.fillRect(0, 0, W, H)
        g.globalAlpha = l.flash
        g.drawImage(scratch, 0, 0)
        continue
      }
      g.globalAlpha = l.alpha
      if (l.x0 > 0) {
        g.save()
        g.beginPath()
        g.rect(l.x0, 0, W - l.x0, H)
        g.clip()
        g.fillStyle = '#000'
        g.fillRect(l.x0, 0, W - l.x0, H)
        drawContain(g, l.image, W, H, l.dx)
        g.restore()
      } else {
        if (l.dx) {
          // 推移时各段连同自己的黑边一起移动
          g.fillStyle = '#000'
          g.fillRect(l.dx, 0, W, H)
        }
        drawContain(g, l.image, W, H, l.dx)
      }
    }
    if (black > 0) {
      g.globalAlpha = Math.min(1, black)
      g.fillStyle = '#000'
      g.fillRect(0, 0, W, H)
    }
    // 叠加轨在背景转场完成后绘制，透明像素直接透出背景，后项在上。
    for (const overlay of activeOverlays) {
      const image = this.frames.get(overlay.key)?.image()
      if (!image) continue
      g.globalAlpha = overlay.opacity
      g.drawImage(image.source, overlay.x * W, overlay.y * H, overlay.width * W, overlay.height * H)
    }
    g.globalAlpha = 1
  }

  private scratch: HTMLCanvasElement | null = null
  private scratchFor(w: number, h: number) {
    const s = (this.scratch ??= document.createElement('canvas'))
    if (s.width !== w) s.width = w
    if (s.height !== h) s.height = h
    return s
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
      const request = new AbortController()
      this.audioRequests.set(assetId, request)
      const current = () =>
        !this.disposed &&
        this.buffers.get(assetId) === p &&
        this.scene.sounds.some((s) => s.assetId === assetId)
      const fail = () => {
        if (!current()) return
        this.failedSounds.add(assetId)
        this.reportIssues()
        this.playhead.pause()
      }
      p = fetch(assetUrls.original(assetId), { signal: request.signal })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status))
          return r.arrayBuffer()
        })
        .catch(() => {
          fail()
          return null
        })
        .then(async (b) => {
          if (!b || !current()) return null
          try {
            const buffer = await ctx.decodeAudioData(b)
            if (current()) {
              this.failedSounds.delete(assetId)
              this.reportIssues()
            }
            return buffer
          } catch {
            // 视频可以没有声轨；独立配音、音效与配乐解码失败需要提示。
            if (!this.scene.clips.some((c) => c.assetId === assetId)) fail()
            return null
          }
        })
        .finally(() => {
          if (this.audioRequests.get(assetId) === request) this.audioRequests.delete(assetId)
        })
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
    const rate = s.rate ?? 1
    let offset = s.offset + Math.max(0, t - s.start) * rate
    if (s.loop) offset %= buf.duration
    else if (offset >= buf.duration) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = !!s.loop
    src.playbackRate.value = rate
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

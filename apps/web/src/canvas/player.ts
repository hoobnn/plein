import { iconElement, type IconName } from '../ui/icons'

/** 播放中鼠标不动多久后收起控制条 */
const IDLE_MS = 2000

function clock(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

function button(label: string, icon: IconName) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'plein-player-btn'
  b.setAttribute('aria-label', label)
  b.title = label
  b.appendChild(iconElement(icon, 16))
  return b
}

function setIcon(b: HTMLButtonElement, icon: IconName, label: string) {
  b.replaceChildren(iconElement(icon, 16))
  b.setAttribute('aria-label', label)
  b.title = label
}

/**
 * 画布里的视频 / 音频播放器：自绘控制条，不用浏览器原生控件。
 * 点画面或按空格播放 / 暂停，←/→ 快退快进 5 秒，M 静音，F 全屏。
 */
export function createPlayer(
  kind: 'video' | 'audio',
  src: string,
  options: { poster?: string } = {},
) {
  const node = document.createElement('div')
  node.className = `plein-player plein-player-${kind}`
  node.tabIndex = -1

  const media = document.createElement(kind)
  media.src = src
  media.autoplay = true
  media.preload = 'metadata'
  if (kind === 'video') (media as HTMLVideoElement).playsInline = true
  node.appendChild(media)

  const poster = kind === 'video' && options.poster ? document.createElement('img') : null
  if (poster) {
    poster.src = options.poster!
    poster.alt = ''
    poster.className = 'pointer-events-none absolute inset-0 size-full object-contain'
    node.appendChild(poster)
  }
  const feedback = document.createElement('div')
  feedback.className =
    'absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 bg-black/40 px-4 pb-12 text-center text-sm text-white'
  feedback.setAttribute('role', 'status')
  const message = document.createElement('span')
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'rounded border border-white/50 px-3 py-1'
  retry.textContent = '重新加载'
  feedback.append(message, retry)
  node.appendChild(feedback)

  const bar = document.createElement('div')
  bar.className = 'plein-player-bar'
  bar.style.zIndex = '2'

  const play = button('播放', 'play')
  const time = document.createElement('span')
  time.className = 'plein-player-time'
  time.textContent = '0:00 / 0:00'

  const track = document.createElement('div')
  track.className = 'plein-player-track'
  track.setAttribute('role', 'slider')
  track.setAttribute('aria-label', '播放进度')
  const buffered = document.createElement('div')
  buffered.className = 'plein-player-buffered'
  const fill = document.createElement('div')
  fill.className = 'plein-player-fill'
  const thumb = document.createElement('div')
  thumb.className = 'plein-player-thumb'
  track.append(buffered, fill, thumb)

  const mute = button('静音', 'sound')
  bar.append(play, time, track, mute)
  let full: HTMLButtonElement | null = null
  if (kind === 'video') {
    full = button('全屏', 'expand')
    bar.appendChild(full)
  }
  node.appendChild(bar)

  let disposed = false
  let presented = false
  let failed = false
  let generation = 0
  let frameCallback: number | undefined
  const animationFrames = new Set<number>()
  const cancelPresentation = () => {
    generation++
    if (frameCallback !== undefined && kind === 'video') {
      ;(media as HTMLVideoElement).cancelVideoFrameCallback?.(frameCallback)
      frameCallback = undefined
    }
    for (const id of animationFrames) cancelAnimationFrame(id)
    animationFrames.clear()
  }
  const showFeedback = (text: string, canRetry = false) => {
    feedback.style.display = text ? 'flex' : 'none'
    message.textContent = text
    retry.hidden = !canRetry
  }
  const present = () => {
    if (disposed || failed) return
    presented = true
    if (poster) poster.hidden = true
    media.style.opacity = '1'
    showFeedback('')
  }
  const fail = () => {
    if (disposed) return
    failed = true
    cancelPresentation()
    media.pause()
    showFeedback('暂时无法播放，请重新加载。原文件仍可下载和使用。', true)
  }
  const waitForFrame = () => {
    if (disposed || failed) return
    if (kind === 'audio' || presented) return present()
    if (frameCallback !== undefined || animationFrames.size) return
    const token = generation
    const video = media as HTMLVideoElement
    if (typeof video.requestVideoFrameCallback === 'function') {
      frameCallback = video.requestVideoFrameCallback(() => {
        frameCallback = undefined
        if (token === generation) present()
      })
    } else if (media.readyState >= 2) {
      const next = (done: () => void) => {
        const id = requestAnimationFrame(() => {
          animationFrames.delete(id)
          if (token === generation && !disposed) done()
        })
        animationFrames.add(id)
      }
      next(() => next(present))
    }
  }
  const start = () => {
    if (disposed) return
    const token = generation
    void media.play().catch(() => {
      if (token === generation) fail()
    })
  }
  const reload = () => {
    if (disposed) return
    cancelPresentation()
    failed = false
    presented = false
    if (poster) poster.hidden = false
    media.style.opacity = kind === 'video' ? '0' : '1'
    showFeedback('正在加载…')
    media.src = src
    media.load()
    start()
  }
  retry.addEventListener('click', reload)
  const toggle = () => {
    if (failed) reload()
    else if (media.paused || media.ended) start()
    else media.pause()
  }
  const seekBy = (d: number) => {
    if (Number.isFinite(media.duration))
      media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + d))
  }

  let scrubbing = false
  const render = () => {
    const d = media.duration
    const t = media.currentTime
    const p = Number.isFinite(d) && d > 0 ? t / d : 0
    fill.style.width = `${p * 100}%`
    thumb.style.left = `${p * 100}%`
    time.textContent = `${clock(t)} / ${clock(d)}`
    track.setAttribute('aria-valuenow', String(Math.round(p * 100)))
    const b = media.buffered
    const end = b.length ? b.end(b.length - 1) : 0
    buffered.style.width = `${Number.isFinite(d) && d > 0 ? (end / d) * 100 : 0}%`
  }
  const renderState = () => {
    const paused = media.paused || media.ended
    setIcon(play, paused ? 'play' : 'pause', paused ? '播放' : '暂停')
    node.classList.toggle('is-paused', paused)
    if (paused) wake()
  }
  const renderVolume = () => {
    setIcon(mute, media.muted ? 'mute' : 'sound', media.muted ? '取消静音' : '静音')
  }

  // 播放中鼠标停住就收起控制条；暂停时一直显示
  let idle: ReturnType<typeof setTimeout> | undefined
  const wake = () => {
    node.classList.remove('is-idle')
    clearTimeout(idle)
    if (disposed) return
    idle = setTimeout(() => {
      if (!media.paused && !scrubbing) node.classList.add('is-idle')
    }, IDLE_MS)
  }

  // 进度条拖动：用 pointer capture，拖出条外也能继续
  const seekTo = (e: PointerEvent) => {
    const r = track.getBoundingClientRect()
    const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    if (Number.isFinite(media.duration)) media.currentTime = p * media.duration
    render()
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    scrubbing = true
    track.setPointerCapture(e.pointerId)
    node.classList.add('is-scrubbing')
    seekTo(e)
  })
  track.addEventListener('pointermove', (e) => scrubbing && seekTo(e))
  const endScrub = () => {
    scrubbing = false
    node.classList.remove('is-scrubbing')
  }
  track.addEventListener('pointerup', endScrub)
  track.addEventListener('pointercancel', endScrub)

  play.addEventListener('click', toggle)
  mute.addEventListener('click', () => (media.muted = !media.muted))
  full?.addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void node.requestFullscreen?.()
  })
  if (kind === 'video') media.addEventListener('click', toggle)

  node.addEventListener('pointermove', wake)
  node.addEventListener('pointerleave', () => {
    if (!media.paused) node.classList.add('is-idle')
  })
  node.addEventListener('keydown', (e) => {
    const k = e.key
    if (k === ' ' || k === 'k') toggle()
    else if (k === 'ArrowLeft') seekBy(-5)
    else if (k === 'ArrowRight') seekBy(5)
    else if (k === 'm') media.muted = !media.muted
    else if (k === 'f' && full) full.click()
    else return
    e.preventDefault()
    wake()
  })

  const onFullscreen = () => {
    const on = document.fullscreenElement === node
    node.classList.toggle('is-fullscreen', on)
    if (full) setIcon(full, on ? 'collapse' : 'expand', on ? '退出全屏' : '全屏')
  }
  document.addEventListener('fullscreenchange', onFullscreen)

  for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'progress', 'seeked'])
    media.addEventListener(ev, render)
  for (const ev of ['play', 'pause', 'ended']) media.addEventListener(ev, renderState)
  media.addEventListener('volumechange', renderVolume)
  media.addEventListener('error', fail)
  media.addEventListener('loadeddata', waitForFrame)
  media.addEventListener('playing', waitForFrame)
  media.addEventListener('waiting', () => {
    if (!disposed && !failed) showFeedback(presented ? '正在缓冲…' : '正在加载…')
  })
  media.style.opacity = kind === 'video' ? '0' : '1'
  showFeedback('正在加载…')
  renderState()
  renderVolume()
  render()
  start()

  return {
    node,
    focus: () => node.focus({ preventScroll: true }),
    dispose() {
      if (disposed) return
      disposed = true
      cancelPresentation()
      clearTimeout(idle)
      document.removeEventListener('fullscreenchange', onFullscreen)
      if (document.fullscreenElement === node) void document.exitFullscreen()
      media.pause()
      media.removeAttribute('src')
      media.load()
    },
  }
}

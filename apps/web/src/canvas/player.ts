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
  // 封面按钮第一次点击会挂载播放器；后续双击不能误点新出现的暂停/静音控件。
  node.addEventListener(
    'click',
    (e) => {
      if (e.detail > 1) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    true,
  )
  node.addEventListener('dblclick', (e) => e.stopPropagation())

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
    'plein-player-feedback absolute inset-0 z-[1] flex flex-col items-center justify-center gap-3 bg-black/40 px-4 pb-12 text-center text-sm text-white'
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
  track.tabIndex = 0
  track.setAttribute('role', 'slider')
  track.setAttribute('aria-label', '播放进度')
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', '100')
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
    node.classList.toggle('has-feedback', !!text)
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
    showFeedback(
      kind === 'audio'
        ? '暂时无法播放，原文件仍可用。'
        : '暂时无法播放，请重新加载。原文件仍可下载和使用。',
      true,
    )
  }
  const waitForFrame = () => {
    if (disposed || failed) return
    if (kind === 'audio' || presented) return present()
    if (frameCallback !== undefined || animationFrames.size) return
    const token = generation
    const video = media as HTMLVideoElement
    // 暂停时可能不会再提交视频帧回调；已有当前帧数据后等两次绘制即可呈现。
    if (typeof video.requestVideoFrameCallback === 'function' && !media.paused) {
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
    void media.play().catch((error: unknown) => {
      // 加载尚未结束时主动暂停会中止 play()，这不是媒体加载失败。
      if (error instanceof DOMException && error.name === 'AbortError') return
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
    track.setAttribute('aria-valuetext', `${clock(t)} / ${clock(d)}`)
    track.setAttribute('aria-disabled', String(!Number.isFinite(d) || d <= 0))
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
  const controlFocused = () =>
    document.activeElement !== node && node.contains(document.activeElement)
  const wake = () => {
    node.classList.remove('is-idle')
    clearTimeout(idle)
    if (disposed) return
    idle = setTimeout(() => {
      if (!media.paused && !scrubbing && !controlFocused()) node.classList.add('is-idle')
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
    track.focus({ preventScroll: true })
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
  node.addEventListener('focusin', wake)
  node.addEventListener('focusout', wake)
  node.addEventListener('pointerleave', () => {
    if (!media.paused && !scrubbing && !controlFocused()) node.classList.add('is-idle')
  })
  node.addEventListener('keydown', (e) => {
    if (
      e.defaultPrevented ||
      e.isComposing ||
      e.keyCode === 229 ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey
    )
      return
    const k = e.key.toLowerCase()
    // 空格交给当前按钮的原生激活行为，不能误触发播放器的播放快捷键。
    if (k === ' ' && (e.target as Element).closest('button')) return
    const onTrack = e.target === track
    if (onTrack && ['home', 'end', 'arrowup', 'arrowdown'].includes(k)) {
      if (k === 'home') seekBy(-media.currentTime)
      else if (k === 'end') seekBy(media.duration)
      else seekBy(k === 'arrowup' ? 5 : -5)
      e.preventDefault()
      wake()
      return
    }
    if (e.repeat && [' ', 'k', 'm', 'f'].includes(k)) {
      e.preventDefault()
      return
    }
    if (k === ' ' || k === 'k') toggle()
    else if (k === 'arrowleft') seekBy(-5)
    else if (k === 'arrowright') seekBy(5)
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
  media.addEventListener('pause', () => {
    if (!disposed && !failed && !presented && media.readyState >= 2) {
      cancelPresentation()
      waitForFrame()
    }
  })
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

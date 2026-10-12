import type { ArrangedClip, SequenceParams, Timeline } from '@plein/nodes'
import { useEffect, useRef, useState } from 'react'
import { assetUrls } from '../api/client'
import { Icon } from '../ui/icons'

const DRIFT = 0.25

/** 让媒体元素停在（或播到）期望的位置；偏差小时不动，避免卡顿 */
function syncMedia(el: HTMLMediaElement, at: number, playing: boolean) {
  if (Math.abs(el.currentTime - at) > DRIFT || !playing) {
    try {
      el.currentTime = Math.max(0, at)
    } catch {}
  }
  if (playing && el.paused) void el.play().catch(() => {})
  if (!playing && !el.paused) el.pause()
}

const clock = (t: number) => {
  const s = Math.max(0, t)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

/**
 * 序列预览：不导出，直接在浏览器里按时间线播放。
 * 两个 video 交替承担相邻镜头（叠化时两段同时可见），对白、音效、配乐各用 Audio 跟着时钟走，
 * 字幕和经黑场转场用叠在上面的 DOM 模拟。和导出的成片在时间上一致，画质和混音是近似的。
 */
export function SequencePreview({
  rows,
  timeline,
  params,
  music,
}: {
  rows: ArrangedClip[]
  timeline: Timeline
  params: SequenceParams
  music?: string
}) {
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const videos = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)]
  const audios = useRef(new Map<string, HTMLAudioElement>())
  const tRef = useRef(0)
  tRef.current = t
  const { total, transition } = timeline
  const portrait = params.aspectRatio === '9:16'

  const audioFor = (key: string, url: string) => {
    let a = audios.current.get(key)
    if (!a) {
      a = new Audio(url)
      a.preload = 'auto'
      audios.current.set(key, a)
    }
    return a
  }

  // 停止和卸载时把所有声音停掉
  useEffect(() => {
    const map = audios.current
    return () => {
      for (const a of map.values()) a.pause()
      map.clear()
    }
  }, [])

  // 播放时钟
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const base = performance.now() - tRef.current * 1000
    const tick = () => {
      const now = (performance.now() - base) / 1000
      if (now >= total) {
        setT(total)
        setPlaying(false)
        return
      }
      setT(now)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, total])

  // 正在画面上的镜头（叠化时最多两段）
  const active = timeline.clips
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.length > 0 && t >= c.start && t < c.start + c.length)
  if (!active.length && total > 0) {
    // 停在结尾时显示最后一段的最后一帧
    const last = timeline.clips
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.length > 0)
      .at(-1)
    if (last && t >= total) active.push(last)
  }

  // 每帧把媒体对齐到时钟
  useEffect(() => {
    const used = new Set<number>()
    for (const { c, i } of active) {
      const slot = i % 2
      used.add(slot)
      const v = videos[slot]!.current
      if (!v) continue
      const url = assetUrls.original(rows[i]!.clip.assetId)
      if (v.dataset.src !== url) {
        v.dataset.src = url
        v.src = url
      }
      v.volume = Math.min(1, params.clipVolume)
      v.muted = params.clipVolume === 0
      syncMedia(v, rows[i]!.in + Math.min(t - c.start, c.length - 0.04), playing)
    }
    for (const slot of [0, 1]) {
      const v = videos[slot]!.current
      if (v && !used.has(slot) && !v.paused) v.pause()
    }
    timeline.clips.forEach((c, i) => {
      const row = rows[i]!
      if (row.dialogue && c.dialogue) {
        const a = audioFor(`d${i}`, assetUrls.original(row.dialogue.assetId))
        a.volume = Math.min(1, params.dialogueVolume)
        const on = t >= c.dialogue.start && t < c.dialogue.start + c.dialogue.duration
        if (on) syncMedia(a, t - c.dialogue.start, playing)
        else if (!a.paused) a.pause()
      }
      if (row.sfx && c.length > 0) {
        const a = audioFor(`s${i}`, assetUrls.original(row.sfx.assetId))
        a.volume = Math.min(1, params.sfxVolume)
        const on = t >= c.start && t < c.start + c.length
        if (on) syncMedia(a, t - c.start, playing)
        else if (!a.paused) a.pause()
      }
    })
    if (music) {
      const a = audioFor('music', assetUrls.original(music))
      a.loop = true
      // 结尾 2 秒淡出，和导出一致
      const fade = Math.min(1, Math.max(0, (total - t) / 2))
      a.volume = Math.min(1, params.musicVolume) * fade
      const len = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0
      syncMedia(a, len ? t % len : t, playing && t < total)
    }
  })

  // 叠化：后一段在重叠部分渐显；经黑场：边界两侧各一半时长压黑
  let black = 0
  const opacity = new Map<number, number>()
  for (const { c, i } of active) {
    let o = 1
    if (transition?.type === 'dissolve' && i > 0 && t < c.start + transition.duration)
      o = Math.max(0, (t - c.start) / transition.duration)
    opacity.set(i % 2, o)
    if (transition?.type === 'fade') {
      const half = transition.duration / 2
      const first = timeline.clips.findIndex((x) => x.length > 0)
      const lastIdx = timeline.clips.findLastIndex((x) => x.length > 0)
      if (i !== first && t - c.start < half) black = Math.max(black, 1 - (t - c.start) / half)
      const left = c.start + c.length - t
      if (i !== lastIdx && left < half) black = Math.max(black, 1 - left / half)
    }
  }
  const topSlot = active.length > 1 ? active.at(-1)!.i % 2 : undefined
  const cue = params.subtitles
    ? timeline.clips.flatMap((c) => c.cues).find((q) => t >= q.start && t < q.end)
    : undefined

  const toggle = () => {
    if (!playing && t >= total) setT(0)
    setPlaying(!playing)
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className={`relative mx-auto overflow-hidden rounded-lg bg-black ${portrait ? 'aspect-[9/16] w-full max-w-72' : 'aspect-video w-full'}`}
      >
        {[0, 1].map((slot) => (
          // biome-ignore lint/a11y/useMediaCaption: 字幕由上面叠加的 DOM 显示
          <video
            key={slot}
            ref={videos[slot]}
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-contain"
            style={{
              opacity: opacity.get(slot) ?? 0,
              zIndex: topSlot === slot ? 2 : 1,
            }}
          />
        ))}
        <div
          className="pointer-events-none absolute inset-0 z-10 bg-black"
          style={{ opacity: black }}
        />
        {cue && (
          <div
            className={`pointer-events-none absolute inset-x-4 z-20 flex justify-center ${portrait ? 'bottom-[12%]' : 'bottom-[7%]'}`}
          >
            <span
              className={`whitespace-pre-line text-center text-white ${
                params.subtitleStyle === '底框'
                  ? 'rounded-xs bg-black/40 px-2 py-0.5 text-sm'
                  : params.subtitleStyle === '醒目'
                    ? 'text-base font-semibold [text-shadow:0_0_3px_#000,0_0_3px_#000,0_0_3px_#000]'
                    : 'text-sm [text-shadow:0_0_2px_#000,0_0_2px_#000]'
              }`}
            >
              {cue.text}
            </span>
          </div>
        )}
        {total === 0 && (
          <div className="absolute inset-0 z-30 flex items-center justify-center text-xs text-white/70">
            没有可播放的镜头
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={playing ? '暂停' : '播放'}
          className="ui-btn ui-btn-secondary ui-btn-sm ui-icon-btn flex-none"
          disabled={total === 0}
          onClick={toggle}
        >
          <Icon name={playing ? 'stop' : 'play'} size={12} />
        </button>
        <input
          type="range"
          aria-label="播放位置"
          className="min-w-0 flex-1"
          min={0}
          max={total || 1}
          step={0.01}
          value={Math.min(t, total)}
          onChange={(e) => {
            setPlaying(false)
            setT(Number(e.target.value))
          }}
        />
        <span className="flex-none text-xs tabular-nums text-ink-subtle">
          {clock(t)} / {clock(total)}
        </span>
      </div>
      <p className="text-2xs text-ink-subtle">
        预览按时间线实时播放，画质与混音是近似的；导出的成片以服务端合成为准。
        {params.asrTiming && ' 语音识别校准的字幕时间只在导出时生效。'}
      </p>
    </div>
  )
}

import type { Cue } from '@plein/nodes'
import { type ComposeTransition, overlapping } from '@plein/plugin-sdk'
import {
  Children,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { Icon, type IconName } from '../../ui/icons'
import { assetUrls } from '../../api/client'
import { Filmstrip, Waveform } from './media'
import { clock, type Playhead } from './playhead'

/** 时间线上的一段镜头和挂在它上面的声音、字幕（时间都是成片里的秒） */
export interface TrackItem {
  key: string
  index: number
  name: string
  /** 还没生成时为空 */
  assetId: string
  kind?: 'image' | 'video'
  pending: boolean
  start: number
  length: number
  /** 素材入点、出点和总时长 */
  in: number
  out?: number
  full?: number
  /** 画面宽高比，胶片条每格的宽度按它算 */
  aspect: number
  /** 播放速度：时间线上的 1 秒 = 素材里的 speed 秒 */
  speed: number
  /** 从上一段切进来的转场 */
  transition?: ComposeTransition
  lines: Array<{ assetId: string; start: number; duration: number; caption?: string }>
  sfx?: { assetId: string; start: number; length: number }
  cues: Cue[]
}

export interface TrimPatch {
  in?: number
  out?: number
}

/** 轨道头宽度，和 .seq-label 一致 */
const LABEL = 88
const PAD = 24
/** 修剪后至少留这么长 */
const MIN_LEN = 0.2
/** 刻度间隔候选（秒）：取让相邻刻度至少隔 72px 的最小一档 */
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
const ZOOM_MAX = 40

const round2 = (n: number) => Math.round(n * 100) / 100

const TRANSITION_LABELS: Record<ComposeTransition['type'], string> = {
  fade: '淡入淡出',
  dissolve: '叠化',
  wipe: '划像',
  slide: '推移',
  flash: '闪白',
}

/**
 * 多轨时间线：画面（胶片条）、对白、音效（波形）、配乐、字幕五条轨。
 * 拖动画面块换顺序，拖两边修剪入出点；点刻度尺或拖播放头定位；⌘/Ctrl + 滚轮缩放。
 */
export function Timeline({
  items,
  total,
  music,
  playhead,
  selected,
  onSelect,
  onMove,
  onTrim,
}: {
  items: TrackItem[]
  total: number
  /** 配乐和它的音量包络（对白时压低的地方画成凹下去） */
  music?: { assetId: string; volume: number; duck: Array<[number, number]> }
  playhead: Playhead
  selected?: string
  onSelect(key: string | undefined): void
  onMove(from: number, to: number): void
  /** 拖动中 done = false（只预览），松手时 done = true（写入） */
  onTrim(key: string, patch: TrimPatch, done: boolean): void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState(0)
  const [zoom, setZoom] = useState(1)

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport(el.clientWidth))
    ro.observe(el)
    setViewport(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // 缩放 1 = 整条刚好铺满
  const fit = Math.max(4, (viewport - LABEL - PAD * 2) / Math.max(total, 1))
  const pps = fit * zoom
  const width = LABEL + PAD * 2 + Math.max(total, 1) * pps
  const x = (t: number) => PAD + t * pps
  const step = STEPS.find((s) => s * pps >= 72) ?? STEPS.at(-1)!

  // 播放头直接改 DOM；播放时跟着滚动，别跑出视野
  const ppsRef = useRef(pps)
  ppsRef.current = pps
  useEffect(() => {
    const update = () => {
      const el = head.current
      const sc = scroller.current
      if (!el || !sc) return
      const px = LABEL + PAD + playhead.t * ppsRef.current
      el.style.transform = `translateX(${px}px)`
      if (playhead.playing) {
        const right = sc.scrollLeft + sc.clientWidth
        if (px > right - 48 || px < sc.scrollLeft + LABEL)
          sc.scrollLeft = Math.max(0, px - LABEL - 48)
      }
    }
    update()
    return playhead.subscribe(update)
  }, [playhead, pps])

  /** 以屏幕横坐标 clientX 处为中心缩放，鼠标下的时刻不动 */
  const zoomAt = (next: number, clientX?: number) => {
    const sc = scroller.current
    const z = Math.min(ZOOM_MAX, Math.max(1, next))
    if (!sc) return setZoom(z)
    const rect = sc.getBoundingClientRect()
    const cx = (clientX ?? rect.left + LABEL + (rect.width - LABEL) / 2) - rect.left
    const t = (sc.scrollLeft + cx - LABEL - PAD) / pps
    setZoom(z)
    requestAnimationFrame(() => {
      sc.scrollLeft = Math.max(0, LABEL + PAD + t * fit * z - cx)
    })
  }

  // ⌘/Ctrl + 滚轮（触控板捏合也是这个）缩放；要 passive: false 才能拦下页面缩放
  const zoomRef = useRef(zoomAt)
  zoomRef.current = zoomAt
  const zRef = useRef(zoom)
  zRef.current = zoom
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomRef.current(zRef.current * Math.exp(-e.deltaY * 0.01), e.clientX)
    }
    sc.addEventListener('wheel', wheel, { passive: false })
    return () => sc.removeEventListener('wheel', wheel)
  }, [])

  /** 刻度尺和播放头：按下就定位，拖动跟着走 */
  const scrub = (e: ReactPointerEvent) => {
    const sc = scroller.current
    if (!sc || e.button !== 0) return
    e.preventDefault()
    playhead.pause()
    const at = (clientX: number) =>
      (clientX - sc.getBoundingClientRect().left + sc.scrollLeft - LABEL - PAD) / ppsRef.current
    playhead.seek(at(e.clientX))
    const move = (ev: PointerEvent) => playhead.seek(at(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const ticks = []
  for (let t = 0; t <= Math.max(total, 1) + 1e-6; t += step) ticks.push(t)

  return (
    <section className="seq-timeline" aria-label="时间线">
      <div className="seq-toolbar">
        <span className="seq-toolbar-hint">拖动镜头换顺序，拖两边修剪，⌘ / Ctrl + 滚轮缩放</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            aria-label="缩小"
            disabled={zoom <= 1}
            onClick={() => zoomAt(zoom / 1.5)}
          >
            <Icon name="zoomOut" size={14} />
          </button>
          <input
            type="range"
            aria-label="缩放"
            className="seq-zoom"
            min={0}
            max={Math.log(ZOOM_MAX)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(e) => zoomAt(Math.exp(Number(e.target.value)))}
          />
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            aria-label="放大"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => zoomAt(zoom * 1.5)}
          >
            <Icon name="zoomIn" size={14} />
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-quiet ui-btn-sm ui-icon-btn"
            aria-label="铺满"
            title="整条铺满"
            disabled={zoom === 1}
            onClick={() => zoomAt(1)}
          >
            <Icon name="fit" size={14} />
          </button>
        </span>
      </div>

      <div ref={scroller} className="seq-scroll ui-scrollbar">
        <div className="seq-content" style={{ width }}>
          <div className="seq-row seq-ruler-row">
            <div className="seq-label" />
            <div
              className="seq-ruler"
              style={
                { '--minor': `${(step * pps) / 5}px`, '--pad': `${PAD}px` } as React.CSSProperties
              }
              onPointerDown={scrub}
            >
              {ticks.map((t) => (
                <span key={t} className="seq-tick" style={{ left: x(t) }}>
                  {clock(t).replace(/\.0$/, '')}
                </span>
              ))}
            </div>
          </div>

          <ClipTrack
            items={items}
            pps={pps}
            x={x}
            selected={selected}
            playhead={playhead}
            onSelect={onSelect}
            onMove={onMove}
            onTrim={onTrim}
          />

          <Track label="对白" icon="mic" kind="dialogue" empty="把配音连到序列的「对白」端口">
            {items.flatMap((it) =>
              it.lines.map((l) => (
                <button
                  key={`${it.key}:${l.assetId}:${l.start}`}
                  type="button"
                  className="seq-block seq-block-audio"
                  data-selected={selected === it.key || undefined}
                  style={{ left: x(l.start), width: l.duration * pps }}
                  title={l.caption}
                  onClick={() => onSelect(it.key)}
                >
                  <Waveform assetId={l.assetId} from={0} to={l.duration} width={l.duration * pps} />
                  {l.caption && <span className="seq-block-label">{l.caption}</span>}
                </button>
              )),
            )}
          </Track>

          <Track label="音效" icon="sound" kind="sfx" empty="没有音效">
            {items.flatMap((it) =>
              it.sfx
                ? [
                    <button
                      key={it.key}
                      type="button"
                      className="seq-block seq-block-audio"
                      data-selected={selected === it.key || undefined}
                      style={{ left: x(it.sfx.start), width: it.sfx.length * pps }}
                      onClick={() => onSelect(it.key)}
                    >
                      <Waveform
                        assetId={it.sfx.assetId}
                        from={0}
                        to={it.sfx.length}
                        width={it.sfx.length * pps}
                      />
                    </button>,
                  ]
                : [],
            )}
          </Track>

          <Track label="配乐" icon="music" kind="music" empty="把配乐连到序列的「配乐」端口">
            {music && total > 0 && (
              <div
                className="seq-block seq-block-music"
                style={{
                  left: x(0),
                  width: total * pps,
                  opacity: 0.4 + 0.6 * Math.min(1, music.volume),
                }}
              >
                <Waveform assetId={music.assetId} from={0} to={total} width={total * pps} loop />
                {music.duck.length > 0 && (
                  // 音量线：对白处压低（和导出的包络同一份）
                  <svg
                    className="seq-envelope"
                    viewBox={`0 0 ${total} 1`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <polyline
                      points={[[0, 1] as const, ...music.duck, [total, 1] as const]
                        .map(([t, v]) => `${t},${1 - v * 0.8}`)
                        .join(' ')}
                    />
                  </svg>
                )}
                {/* 结尾 2 秒淡出 */}
                <span className="seq-fade-out" style={{ width: Math.min(total, 2) * pps }} />
              </div>
            )}
          </Track>

          <Track label="字幕" icon="captions" kind="text" empty="没有字幕">
            {items.flatMap((it) =>
              it.cues.map((q) => (
                <button
                  key={`${it.key}:${q.start}`}
                  type="button"
                  className="seq-block seq-block-text"
                  data-selected={selected === it.key || undefined}
                  style={{ left: x(q.start), width: Math.max(2, (q.end - q.start) * pps) }}
                  title={q.text}
                  onClick={() => {
                    onSelect(it.key)
                    playhead.seek(q.start)
                  }}
                >
                  <span className="seq-block-label">{q.text}</span>
                </button>
              )),
            )}
          </Track>

          <div ref={head} className="seq-playhead" aria-hidden="true">
            <span className="seq-playhead-grip" onPointerDown={scrub} />
          </div>
        </div>
      </div>
    </section>
  )
}

function Track({
  label,
  icon,
  kind,
  empty,
  children,
}: {
  label: string
  icon: 'mic' | 'sound' | 'music' | 'captions'
  /** 轨道的颜色：.seq-row[data-track] 里给 --track */
  kind: 'dialogue' | 'sfx' | 'music' | 'text'
  /** 轨道上什么都没有时的提示 */
  empty: string
  children: React.ReactNode
}) {
  const blank = Children.toArray(children).length === 0
  return (
    <div className="seq-row" data-track={kind}>
      <TrackLabel icon={icon} label={label} />
      <div className="seq-lane">
        {blank ? <span className="seq-lane-empty">{empty}</span> : children}
      </div>
    </div>
  )
}

function TrackLabel({ icon, label }: { icon: IconName; label: string }) {
  return (
    <div className="seq-label">
      <span className="seq-label-icon">
        <Icon name={icon} size={12} />
      </span>
      {label}
    </div>
  )
}

interface Drag {
  index: number
  dx: number
  /** 落下后要插到的位置 */
  target: number
}

/**
 * 画面轨：拖块换顺序（其余块让位），拖两边修剪。
 * 落下时块从松手处滑到新位置（FLIP），不是瞬移。
 */
function ClipTrack({
  items,
  pps,
  x,
  selected,
  playhead,
  onSelect,
  onMove,
  onTrim,
}: {
  items: TrackItem[]
  pps: number
  x(t: number): number
  selected?: string
  playhead: Playhead
  onSelect(key: string | undefined): void
  onMove(from: number, to: number): void
  onTrim(key: string, patch: TrimPatch, done: boolean): void
}) {
  const [drag, setDrag] = useState<Drag | null>(null)
  /** 落下后的位移补偿：先停在松手处，下一帧滑回 0 */
  const [settle, setSettle] = useState<{ key: string; dx: number; animate: boolean } | null>(null)
  const [trimming, setTrimming] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (!settle || settle.animate) return
    const raf = requestAnimationFrame(() => setSettle({ ...settle, dx: 0, animate: true }))
    return () => cancelAnimationFrame(raf)
  }, [settle])

  const startDrag = (e: ReactPointerEvent, index: number) => {
    if (e.button !== 0) return
    const item = items[index]!
    onSelect(item.key)
    const x0 = e.clientX
    let moved = false
    let current: Drag = { index, dx: 0, target: index }
    const center = (it: TrackItem) => x(it.start) + (it.length * pps) / 2
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 4) return
      moved = true
      const mine = center(item) + dx
      let target = items.filter((it, i) => i !== index && center(it) < mine).length
      target = Math.min(items.length - 1, Math.max(0, target))
      current = { index, dx, target }
      setDrag(current)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (!moved) {
        playhead.pause()
        playhead.seek(item.start)
        return
      }
      if (current.target !== index) {
        // 新位置的起点：按新顺序把前面各段的长度加起来（重叠转场的重叠部分按原样估计）
        const order = items.filter((_, i) => i !== index)
        order.splice(current.target, 0, item)
        let start = 0
        for (const it of order) {
          if (it === item) break
          if (it.length > 0)
            start += it.length - (overlapping(it.transition) ? it.transition!.duration : 0)
        }
        start = Math.max(0, start)
        setSettle({ key: item.key, dx: x(item.start) + current.dx - x(start), animate: false })
        onMove(index, current.target)
      } else setSettle({ key: item.key, dx: current.dx, animate: false })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startTrim = (e: ReactPointerEvent, item: TrackItem, edge: 'in' | 'out') => {
    if (e.button !== 0 || item.pending) return
    e.stopPropagation()
    e.preventDefault()
    onSelect(item.key)
    playhead.pause()
    setTrimming(item.key)
    const x0 = e.clientX
    const full = item.full ?? item.in + item.length
    const in0 = item.in
    const out0 = Math.min(item.out ?? full, full)
    // 短素材或手动设置过的短区间不能被固定的最短长度推到素材范围外。
    const minLength = Math.min(MIN_LEN, Math.max(0, out0 - in0))
    let patch: TrimPatch = {}
    const move = (ev: PointerEvent) => {
      // 拖动距离是成片时间，换算成素材时间
      const d = ((ev.clientX - x0) / pps) * item.speed
      if (edge === 'in') {
        const v = Math.max(0, Math.min(out0 - minLength, round2(in0 + d)))
        patch = { in: v }
        playhead.seek(item.start)
      } else {
        const v = Math.min(full, Math.max(in0 + minLength, round2(out0 + d)))
        // 拖回素材结尾就是“到结尾”
        patch = { out: v >= full - 0.01 ? undefined : v }
        playhead.seek(item.start + (v - in0) / item.speed - 0.04)
      }
      onTrim(item.key, patch, false)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setTrimming(null)
      if ('in' in patch || 'out' in patch) onTrim(item.key, patch, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const w = drag ? items[drag.index]!.length * pps : 0
  return (
    <div className="seq-row seq-row-clips" data-track="video">
      <TrackLabel icon="video" label="画面" />
      <div className="seq-lane">
        {items.map((it, i) => {
          let dx = 0
          let moving = false
          if (drag) {
            if (i === drag.index) {
              dx = drag.dx
              moving = true
            } else if (drag.index < drag.target && i > drag.index && i <= drag.target) dx = -w
            else if (drag.index > drag.target && i >= drag.target && i < drag.index) dx = w
          } else if (settle?.key === it.key) dx = settle.dx
          // 落下那一帧所有块都瞬间就位（让位的块新 left 正好等于原 left + 让位量），只有被拖的块滑过去
          const animate = !moving && !(settle && !settle.animate)
          const width = Math.max(it.length * pps, 2)
          return (
            <div
              key={it.key}
              role="button"
              tabIndex={0}
              aria-label={it.name}
              aria-pressed={selected === it.key}
              className="seq-clip"
              data-selected={selected === it.key || undefined}
              data-pending={it.pending || undefined}
              data-moving={moving || undefined}
              data-trimming={trimming === it.key || undefined}
              style={{
                left: x(it.start),
                width,
                transform: dx ? `translateX(${dx}px)` : undefined,
                transition: animate ? undefined : 'none',
              }}
              onPointerDown={(e) => startDrag(e, i)}
              // 键盘 Tab 到哪段就选中哪段；选中样式就是焦点样式
              onFocus={() => onSelect(it.key)}
            >
              {!it.pending && it.kind === 'image' && (
                <img
                  src={assetUrls.original(it.assetId)}
                  alt=""
                  className="h-full w-full object-cover"
                />
              )}
              {!it.pending && it.kind !== 'image' && (
                <Filmstrip
                  assetId={it.assetId}
                  duration={it.full}
                  aspect={it.aspect}
                  from={it.in}
                  to={it.in + it.length * it.speed}
                  width={width}
                  height={64}
                />
              )}
              <span className="seq-clip-name">
                {String(i + 1).padStart(2, '0')}{' '}
                {it.pending ? (it.kind === 'image' ? '缺少分镜图' : '还没有生成') : it.name}
              </span>
              {!it.pending && (
                <span className="seq-clip-len">
                  {it.speed !== 1 && `${it.speed}× · `}
                  {it.length.toFixed(1)}s
                </span>
              )}
              {!it.pending && it.kind !== 'image' && (
                <>
                  <span
                    className="seq-trim seq-trim-in"
                    title="拖动修剪入点"
                    onPointerDown={(e) => startTrim(e, it, 'in')}
                  />
                  <span
                    className="seq-trim seq-trim-out"
                    title="拖动修剪出点"
                    onPointerDown={(e) => startTrim(e, it, 'out')}
                  />
                </>
              )}
            </div>
          )
        })}
        {!drag &&
          items.map((it) => {
            const tr = it.transition
            if (!tr) return null
            // 重叠转场盖住重叠的那一截；经黑场骑在交界处
            const from = overlapping(tr) ? it.start : it.start - tr.duration / 2
            return (
              <button
                key={`tr-${it.key}`}
                type="button"
                className="seq-transition"
                data-selected={selected === it.key || undefined}
                aria-label={`${it.name} 的转场`}
                title={`${TRANSITION_LABELS[tr.type]} ${tr.duration} 秒`}
                style={{ left: x(from), width: Math.max(tr.duration * pps, 24) }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onSelect(it.key)}
              >
                <span className="seq-transition-chip">
                  <Icon name="transition" size={12} />
                </span>
              </button>
            )
          })}
      </div>
    </div>
  )
}

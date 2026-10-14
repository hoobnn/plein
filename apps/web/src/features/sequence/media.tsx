import { type AudioPeaks, FILMSTRIP_FRAMES } from '@plein/protocol'
import { useEffect, useState } from 'react'
import { assetUrls } from '../../api/client'

/** 峰值整个会话缓存一份（资产不可变）；取不到的不缓存，下次再试 */
const peaksCache = new Map<string, Promise<AudioPeaks | null>>()

function loadPeaks(assetId: string) {
  let p = peaksCache.get(assetId)
  if (!p) {
    p = fetch(assetUrls.variant(assetId, 'peaks'))
      .then((r) => (r.ok ? (r.json() as Promise<AudioPeaks>) : null))
      .catch(() => null)
      .then((v) => {
        if (!v) peaksCache.delete(assetId)
        return v
      })
    peaksCache.set(assetId, p)
  }
  return p
}

function usePeaks(assetId: string | undefined) {
  const [peaks, setPeaks] = useState<AudioPeaks | null>(null)
  useEffect(() => {
    setPeaks(null)
    if (!assetId) return
    let live = true
    void loadPeaks(assetId).then((p) => live && setPeaks(p))
    return () => {
      live = false
    }
  }, [assetId])
  return peaks
}

/** 一条波形最多画这么多根柱子，再放大只是拉宽（矢量，不糊） */
const MAX_BARS = 1200

/**
 * 波形：上下对称的柱状 SVG，铺满父元素。
 * from / to 是素材里的秒数范围；loop 时超出素材长度的部分从头接上（配乐循环铺满）。
 */
export function Waveform({
  assetId,
  from,
  to,
  width,
  loop = false,
}: {
  assetId: string | undefined
  from: number
  to: number
  /** 屏幕上的宽度（px），决定柱子数 */
  width: number
  loop?: boolean
}) {
  const data = usePeaks(assetId)
  if (!data || to <= from || width <= 0) return null
  const { rate, peaks } = data
  const span = peaks.length / rate
  const bars = Math.max(1, Math.min(MAX_BARS, Math.floor(width / 3)))
  const step = (to - from) / bars
  // 整条按最响处归一，轻声的对白也看得出起伏
  const max = Math.max(0.05, ...peaks)
  let d = ''
  for (let i = 0; i < bars; i++) {
    let a = from + i * step
    let b = a + step
    if (loop && span > 0) {
      a %= span
      b = a + step
    }
    let v = 0
    for (let k = Math.floor(a * rate); k < Math.ceil(b * rate) && k < peaks.length; k++)
      v = Math.max(v, peaks[k] ?? 0)
    const h = Math.max(0.04, Math.sqrt(v / max)) * 50
    d += `M${i * 3} ${50 - h}h2v${h * 2}h-2z`
  }
  return (
    <svg
      className="seq-wave"
      viewBox={`0 0 ${bars * 3} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

/**
 * 胶片条：按块的宽度铺满等高的帧，每格显示它所在时刻最近的那帧。
 * 图是服务端拼好的横条（FILMSTRIP_FRAMES 帧），这里只是用背景位置裁出来，不画 canvas。
 */
export function Filmstrip({
  assetId,
  duration,
  aspect,
  from,
  to,
  width,
  height,
}: {
  assetId: string
  /** 素材总时长 */
  duration: number | undefined
  /** 素材宽高比 */
  aspect: number
  from: number
  to: number
  width: number
  height: number
}) {
  const [ready, setReady] = useState(false)
  const url = assetUrls.variant(assetId, 'filmstrip')
  useEffect(() => {
    setReady(false)
    let live = true
    const img = new Image()
    img.onload = () => live && setReady(true)
    img.src = url
    return () => {
      live = false
    }
  }, [url])
  if (!ready || !duration || width <= 0) return null
  const tile = Math.max(8, height * aspect)
  const count = Math.min(200, Math.ceil(width / tile))
  const cells = []
  for (let i = 0; i < count; i++) {
    const at = from + ((i + 0.5) * tile * (to - from)) / width
    const k = Math.min(
      FILMSTRIP_FRAMES - 1,
      Math.max(0, Math.round((at / duration) * FILMSTRIP_FRAMES - 0.5)),
    )
    cells.push(
      <span
        key={i}
        style={{
          width: tile,
          backgroundImage: `url(${url})`,
          backgroundSize: `${tile * FILMSTRIP_FRAMES}px ${height}px`,
          backgroundPosition: `${-k * tile}px 0`,
        }}
      />,
    )
  }
  return (
    <div className="seq-filmstrip" aria-hidden="true">
      {cells}
    </div>
  )
}

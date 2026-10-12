import type { Engine } from '@plein/canvas-core'
import { createElements, type NewElement } from '@plein/doc'
import {
  API,
  type Asset,
  type AssetKind,
  type MediaCapsInfo,
  type MediaDerivation,
  type MediaDeriveRequest,
  type MediaOp,
} from '@plein/protocol'
import { freeSpotRight } from './presets'

/** 变速可选的倍数：本地工具直接改素材，不是 TTS 那种合成时的语速参数 */
export const SPEEDS = [0.5, 0.75, 1.5, 2, 3] as const

/** 服务端允许的变速范围，这里先夹一次，省得把明显越界的值发出去 */
export const SPEED_RANGE = { min: 0.25, max: 4 } as const

/** 多个产物（音视频分离）之间的间距 */
const GAP = 16

/** 时间码 → 秒。支持 `12.5` / `1:02` / `1:02.5` / `00:01:02.5`，不合法返回 null */
export function parseTimecode(text: string): number | null {
  const raw = text.trim().replace(/[,，]/g, '.')
  if (!raw) return null
  const parts = raw.split(':')
  if (parts.length > 3) return null
  let seconds = 0
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part)) return null
    seconds = seconds * 60 + Number(part)
  }
  return Number.isFinite(seconds) ? seconds : null
}

/** 秒 → `01:02.5`，超过一小时给 `1:02:03`；用于输入框的回显 */
export function formatTimecode(seconds: number) {
  const t = Math.max(0, seconds)
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const head = m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : String(m)
  return `${head}:${s < 10 ? '0' : ''}${Number(s.toFixed(1))}`
}

/** 夹到合法区间；起倒挂或出界返回 null，让调用方提示而不是默默改用户输入 */
export function clampRange(
  start: number,
  end: number,
  duration?: number,
): { start: number; end: number } | null {
  const hi = duration ?? Number.POSITIVE_INFINITY
  const s = Math.max(0, start)
  const e = Math.min(end, hi)
  if (!(e > s) || s > hi) return null
  return { start: Number(s.toFixed(2)), end: Number(e.toFixed(2)) }
}

/** 平均切分成 n 段，供“切分”一步给出可用的默认区间 */
export function evenSegments(
  duration: number,
  count: number,
): Array<{ start: number; end: number }> {
  const n = Math.max(2, Math.min(12, Math.round(count)))
  const step = duration / n
  return Array.from({ length: n }, (_, i) => ({
    start: Number((i * step).toFixed(2)),
    end: Number(Math.min(duration, (i + 1) * step).toFixed(2)),
  }))
}

export function clampSpeed(speed: number) {
  return Number(Math.min(SPEED_RANGE.max, Math.max(SPEED_RANGE.min, speed)).toFixed(2))
}

/** 裁剪框默认值：整张图；再夹一次，保证不会超过摆正后的尺寸 */
export function cropRect(
  rect: { left: number; top: number; width: number; height: number },
  size: { width?: number; height?: number },
) {
  const w = size.width ?? Number.POSITIVE_INFINITY
  const h = size.height ?? Number.POSITIVE_INFINITY
  const width = Math.max(1, Math.min(Math.round(rect.width), w - Math.max(0, rect.left)))
  const height = Math.max(1, Math.min(Math.round(rect.height), h - Math.max(0, rect.top)))
  return {
    left: Math.max(0, Math.min(Math.round(rect.left), w - 1)),
    top: Math.max(0, Math.min(Math.round(rect.top), h - 1)),
    width,
    height,
  }
}

/** 某种素材能做哪些加工：UI 只显示做得到的，能力缺失（比如没有 ffmpeg）时先说清楚 */
export function opsFor(kind: AssetKind, caps?: MediaCapsInfo | null): MediaOp[] {
  if (kind === 'image') return ['crop', 'rotate', 'flip']
  // 音视频全靠 ffmpeg；能力还没读到（caps 为空）时先照常显示，服务端会兜底报 503
  if (caps && !caps.ffmpeg) return []
  if (kind === 'audio') return ['trim', 'speed', 'split']
  if (kind === 'video') return ['trim', 'speed', 'separate', 'frame']
  return []
}

/** 多选时的一键操作：不需要填参数的那几个 */
export function quickOpsFor(kind: AssetKind): MediaOp[] {
  if (kind === 'image') return ['rotate', 'flip']
  if (kind === 'audio') return ['speed']
  if (kind === 'video') return ['speed', 'separate', 'frame']
  return []
}

const OP_LABEL: Record<MediaOp, string> = {
  crop: '裁剪',
  rotate: '旋转',
  flip: '镜像',
  trim: '截取',
  speed: '变速',
  split: '切分',
  separate: '分离音视频',
  frame: '抽帧',
}

export const opLabel = (op: MediaOp) => OP_LABEL[op]

/** 「裁剪 10×10 @ (5,5)」这类描述，展示来源用 */
export function deriveLabel(op: MediaOp, params: Record<string, unknown>) {
  const n = (key: string) => Number(params[key] ?? 0)
  switch (op) {
    case 'crop':
      return `${n('width')}×${n('height')} @ (${n('left')},${n('top')})`
    case 'rotate':
      return `${n('angle')}°`
    case 'flip':
      return params.axis === 'horizontal' ? '左右翻转' : '上下翻转'
    case 'trim':
      return `${formatTimecode(n('start'))} – ${formatTimecode(n('end'))}`
    case 'speed':
      return `${n('speed')}×${params.keepPitch === false ? '（变调）' : ''}`
    case 'split':
      return `${(params.segments as unknown[] | undefined)?.length ?? 0} 段`
    case 'frame':
      return formatTimecode(n('at'))
    default:
      return ''
  }
}

/** 画布上素材元素的尺寸：图片视频按原始比例缩到长边 480，音频用固定高度 */
export function elementSize(
  asset: Asset,
): { kind: NewElement['kind']; w: number; h: number } | null {
  const fit = (fallback: [number, number]) => {
    if (!asset.width || !asset.height) return fallback
    const k = Math.min(1, 480 / Math.max(asset.width, asset.height))
    return [Math.round(asset.width * k), Math.round(asset.height * k)] as const
  }
  if (asset.kind === 'image') {
    const [w, h] = fit([320, 240])
    return { kind: 'image', w, h }
  }
  if (asset.kind === 'video') {
    const [w, h] = fit([480, 270])
    return { kind: 'video', w, h }
  }
  if (asset.kind === 'audio') return { kind: 'audio', w: 384, h: 96 }
  return null
}

/** 加工请求：服务端统一执行，前端只负责填参数 */
export async function mediaDerive(input: MediaDeriveRequest): Promise<MediaDerivation> {
  const res = await fetch(API.mediaDerive, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `加工失败（${res.status}）`)
  }
  return (await res.json()) as MediaDerivation
}

let capsCache: Promise<MediaCapsInfo> | null = null

/** 本机媒体能力；同一会话里只问一次，失败了下次再问 */
export function mediaCaps(): Promise<MediaCapsInfo> {
  capsCache ??= fetch(API.mediaCaps, { credentials: 'same-origin' })
    .then((res) => {
      if (!res.ok) throw new Error('读不到本机媒体能力')
      return res.json() as Promise<MediaCapsInfo>
    })
    .catch((err) => {
      capsCache = null
      throw err
    })
  return capsCache
}

/**
 * 加工并把产物摆到源元素右边：加工永远产出新资产，原来的素材不动。
 * 产物可以像导入的素材一样继续用、继续加工、进入导出。
 */
export async function applyDerivation(
  engine: Engine,
  input: MediaDeriveRequest,
  nearId: string,
): Promise<MediaDerivation> {
  const made = await mediaDerive(input)
  // 分离会一次出两个资产，先量好整组的尺寸再找位置，否则两个会叠在一起
  const sizes = made.assets
    .map((asset) => ({ asset, size: elementSize(asset) }))
    .filter(
      (it): it is { asset: Asset; size: { kind: NewElement['kind']; w: number; h: number } } =>
        !!it.size,
    )
  const list: NewElement[] = []
  if (sizes.length) {
    const totalW = sizes.reduce((sum, it, i) => sum + it.size.w + (i ? GAP : 0), 0)
    const rowH = Math.max(...sizes.map((it) => it.size.h))
    const spot = freeSpotRight(engine, nearId, totalW, rowH)
    let x = spot.x
    for (const { asset, size } of sizes) {
      list.push({
        kind: size.kind,
        assetId: asset.id,
        name: asset.name,
        w: size.w,
        h: size.h,
        x: Math.round(x),
        y: Math.round(spot.y + (rowH - size.h) / 2),
      })
      x += size.w + GAP
    }
    engine.selection.set(createElements(engine.doc, list))
  }
  return made
}

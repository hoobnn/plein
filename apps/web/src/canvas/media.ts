import type { Engine } from '@plein/canvas-core'
import { elementMedia, mediaSize, type NewElement, ReadOnlyDocError } from '@plein/doc'
import type {
  Asset,
  AssetKind,
  MediaCapsInfo,
  MediaDerivation,
  MediaDeriveRequest,
  MediaOp,
} from '@plein/protocol'
import { api } from '../api/client'
import { freeSpotRight } from './presets'
import { placeImports } from './import'

/** 变速可选的倍数：本地工具直接改素材，不是 TTS 那种合成时的语速参数 */
export const SPEEDS = [0.5, 0.75, 1.5, 2, 3] as const

/** 服务端允许的变速范围；无效输入由表单提示，不擅自改变用户的倍数。 */
const SPEED_RANGE = { min: 0.25, max: 4 } as const

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

/** 夹到素材范围；无效数字、倒挂或夹紧后没有长度时返回 null，保留输入精度。 */
export function clampRange(
  start: number,
  end: number,
  duration?: number,
): { start: number; end: number } | null {
  const hi = duration ?? Number.POSITIVE_INFINITY
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const s = Math.max(0, start)
  const e = Math.min(end, hi)
  if (!(e > s) || s > hi) return null
  return { start: s, end: e }
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

export function validSpeed(speed: number) {
  return Number.isFinite(speed) && speed >= SPEED_RANGE.min && speed <= SPEED_RANGE.max
    ? speed
    : null
}

type CropRect = { left: number; top: number; width: number; height: number }

/** 校验真实像素范围，不把无效输入悄悄改成其他裁剪区域。 */
export function cropRect(
  rect: CropRect,
  size: { width?: number; height?: number; kind?: AssetKind },
): CropRect | { field: keyof CropRect; error: string } {
  const type = size.kind === 'video' ? '视频' : '图片'
  for (const [field, label, minimum] of [
    ['left', '左侧坐标', 0],
    ['top', '顶部坐标', 0],
    ['width', '宽度', 1],
    ['height', '高度', 1],
  ] as const) {
    if (!Number.isSafeInteger(rect[field]) || rect[field] < minimum)
      return { field, error: `${label}需为${minimum ? '大于 0' : '不小于 0'}的整数` }
    if (field === 'left' && size.width !== undefined && rect.left >= size.width)
      return { field: 'left', error: `左侧坐标需小于${type}宽度（${size.width} 像素）` }
    if (field === 'top' && size.height !== undefined && rect.top >= size.height)
      return { field: 'top', error: `顶部坐标需小于${type}高度（${size.height} 像素）` }
  }
  if (size.width !== undefined) {
    if (rect.left + rect.width > size.width)
      return { field: 'width', error: `裁剪区域超出${type}宽度（${size.width} 像素）` }
  }
  if (size.height !== undefined) {
    if (rect.top + rect.height > size.height)
      return { field: 'height', error: `裁剪区域超出${type}高度（${size.height} 像素）` }
  }
  if (size.kind === 'video') {
    for (const field of ['width', 'height'] as const)
      if (rect[field] % 2)
        return { field, error: `视频裁剪${field === 'width' ? '宽度' : '高度'}需为偶数像素` }
  }
  return rect
}

/** 某种素材能做哪些加工：UI 只显示做得到的，能力缺失（比如没有 ffmpeg）时先说清楚 */
export function opsFor(kind: AssetKind, caps?: MediaCapsInfo | null): MediaOp[] {
  if (kind === 'image') return ['crop', 'rotate', 'flip']
  // 音视频全靠 ffmpeg；能力还没读到（caps 为空）时先照常显示，服务端会兜底报 503
  if (caps && !caps.ffmpeg) return []
  if (kind === 'audio') return ['trim', 'speed', 'split']
  if (kind === 'video') return ['crop', 'trim', 'speed', 'separate', 'frame']
  return []
}

/** 多选时可批量处理的操作；变速和抽帧共用设置 */
export function quickOpsFor(kind: AssetKind): MediaOp[] {
  if (kind === 'image') return ['rotate', 'flip']
  if (kind === 'audio') return ['speed']
  if (kind === 'video') return ['speed', 'separate', 'frame']
  return []
}

/** 按当前本机能力筛选，每项操作只处理适用素材，保持来源顺序。 */
export function mediaTargetsFor(
  targets: readonly MediaTarget[],
  op: MediaOp,
  caps?: MediaCapsInfo | null,
) {
  return targets.filter((target) => opsFor(target.kind, caps).includes(op))
}

/** 固定菜单顺序，不让第一个选中素材决定其他类型能做什么。 */
export function batchMediaOps(
  targets: readonly MediaTarget[],
  caps?: MediaCapsInfo | null,
): MediaOp[] {
  const requested = new Set(targets.flatMap((target) => quickOpsFor(target.kind)))
  return (['rotate', 'flip', 'speed', 'separate', 'frame'] as const).filter(
    (op) => requested.has(op) && mediaTargetsFor(targets, op, caps).length > 0,
  )
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
      return params.last ? '尾帧' : formatTimecode(n('at'))
    default:
      return ''
  }
}

/** 画布上素材元素的尺寸：图片视频按原始比例缩到长边 480，音频用固定高度 */
export function elementSize(
  asset: Asset,
): { kind: NewElement['kind']; w: number; h: number } | null {
  const { kind } = asset
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return null
  return { kind, ...mediaSize(kind, asset.width, asset.height) }
}

let capsCache: Promise<MediaCapsInfo> | null = null

/** 本机媒体能力；同一会话里只问一次，失败了下次再问 */
export function mediaCaps(): Promise<MediaCapsInfo> {
  capsCache ??= api.mediaCaps().catch((err) => {
    capsCache = null
    throw err
  })
  return capsCache
}

export interface MediaTarget {
  elId: string
  assetId: string
  kind: AssetKind
}

export type DerivedMedia = MediaDerivation & { created: string[] }

/**
 * 加工并把产物摆到源元素右边：加工永远产出新资产，原来的素材不动。
 * 产物可以像导入的素材一样继续用、继续加工、进入导出。
 */
export async function applyDerivation(
  engine: Engine,
  input: MediaDeriveRequest,
  nearId: string,
  signal?: AbortSignal,
): Promise<DerivedMedia> {
  const sourceMap = engine.doc.elementMaps.get(nearId)
  const check = () => {
    signal?.throwIfAborted()
    if (engine.doc.readOnly) throw new ReadOnlyDocError()
    const source = engine.doc.get(nearId)
    if (source?.locked) throw new Error('素材已锁定，本次加工未放入画布，请先解锁')
    if (
      !source ||
      engine.doc.elementMaps.get(nearId) !== sourceMap ||
      elementMedia(source)?.assetId !== input.assetId
    )
      throw new Error('素材已变化，本次加工未放入画布，请重新选择素材')
  }
  check()
  const made = await api.mediaDerive(input, signal)
  check()
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
  }
  // 与导入共用最终位置归组，完整放得下才归入框内，并保留整次加工的一步撤销。
  const created = placeImports(engine, list)
  return { ...made, created }
}

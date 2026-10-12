import { AUDIO_SIZE } from './types'

/** 出图 / 视频节点的长边：卡片按画幅取形状，结果出来后正好铺满 */
export const MEDIA_LONG_SIDE = 400

/** 画幅值（如 '16:9'）解析成宽高比；不是画幅返回 null */
export function parseAspect(v: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)$/.exec(String(v ?? ''))
  if (!m) return null
  const r = Number(m[1]) / Number(m[2])
  return Number.isFinite(r) && r > 0 ? r : null
}

/** 长边固定、按宽高比求卡片尺寸 */
export function aspectSize(ratio: number, long = MEDIA_LONG_SIDE) {
  return ratio >= 1
    ? { w: long, h: Math.round(long / ratio) }
    : { w: Math.round(long * ratio), h: long }
}

/** 节点在画布上的默认尺寸：按第一个输出的类型；出图 / 视频按画幅取形状，没有画幅时是方形 */
export function nodeSize(out: string | undefined, ratio: number | null) {
  if (out === 'image' || out === 'video') return ratio ? aspectSize(ratio) : { w: 320, h: 320 }
  if (out === 'audio') return { w: 300, h: 160 }
  return { w: 280, h: 200 }
}

/** 素材元素的尺寸：图片视频按原始比例缩到长边 480（不放大），音频用固定高度 */
export function mediaSize(kind: 'image' | 'video' | 'audio', width?: number, height?: number) {
  if (kind === 'audio') return { ...AUDIO_SIZE }
  if (!width || !height) return kind === 'image' ? { w: 320, h: 240 } : { w: 480, h: 270 }
  const k = Math.min(1, 480 / Math.max(width, height))
  return { w: Math.round(width * k), h: Math.round(height * k) }
}

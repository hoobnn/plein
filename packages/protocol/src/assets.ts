import { AssetKind } from '@plein/plugin-sdk'
import { z } from 'zod'

// 资产类型由插件 SDK 定义（AssetRef 也用它），这里再导出给前后端
export { AssetKind }

/**
 * 衍生物：图片缩略图、视频封面、音频波形；
 * filmstrip（视频等距取帧拼成的横条）和 peaks（音频峰值 JSON）给剪辑时间线用，第一次请求时才生成
 */
export const AssetVariant = z.enum([
  'thumb-256',
  'thumb-1024',
  'poster',
  'waveform',
  'filmstrip',
  'peaks',
])
export type AssetVariant = z.infer<typeof AssetVariant>

/** 字幕字体：族名写进 ASS 样式；version 随文件变化，用作字体文件地址的缓存键 */
export interface SubtitleFontInfo {
  family: string
  version: string
}

/** filmstrip 横条里的帧数：第 k 帧取在时长的 (k + 0.5) / 16 处，各帧等宽 */
export const FILMSTRIP_FRAMES = 16

/** peaks 衍生物：每秒 rate 个峰值（0–1，单声道绝对值的最大值） */
export interface AudioPeaks {
  rate: number
  peaks: number[]
}

export const Asset = z.object({
  /** 内容的 SHA-256（十六进制），写入即不可变 */
  id: z.string().regex(/^[0-9a-f]{64}$/),
  kind: AssetKind,
  mime: z.string(),
  name: z.string(),
  size: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  /** 秒 */
  duration: z.number().optional(),
  variants: z.array(AssetVariant),
  createdAt: z.number(),
})
export type Asset = z.infer<typeof Asset>

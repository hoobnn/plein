import type { AssetRef } from './ports'

/** 媒体文件的基本信息（ffprobe） */
export interface MediaInfo {
  /** 秒 */
  duration?: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
}

/**
 * 镜头之间的转场：fade 经黑场淡出淡入（前一段结尾、后一段开头各占一半，不改变总时长）；
 * 其余是重叠转场，相邻镜头重叠 duration 秒（总时长相应缩短）：
 * dissolve 叠化，wipe 划像（后一段从右往左擦出），slide 推移（后一段从右侧推入），flash 闪白
 */
export interface ComposeTransition {
  type: 'fade' | 'dissolve' | 'wipe' | 'slide' | 'flash'
  duration: number
}

/** 重叠型转场：相邻两段重叠播放 */
export const overlapping = (t: ComposeTransition | null | undefined) =>
  !!t && t.type !== 'fade' && t.duration > 0

/** 画面上的一段：按顺序首尾相接 */
export interface ComposeClip {
  asset: AssetRef
  /** 入点、出点（秒，相对素材开头）；出点不填到素材结尾 */
  in: number
  out?: number
  /** 素材自带声音的音量，0 为静音 */
  volume: number
  /** 播放速度，默认 1；成片里这段的时长 = (出点 - 入点) / 速度，声音变速不变调 */
  speed?: number
  /** 从上一段切到这一段的转场；不填用 ComposeSpec.transition，第一段忽略 */
  transition?: ComposeTransition
}

/** 放在时间线上的一段声音 */
export interface ComposeAudio {
  asset: AssetRef
  /** 在成片里开始的时刻（秒） */
  start: number
  /** 最长播放多久（秒）；不填播放到素材结尾或成片结尾 */
  duration?: number
  volume: number
  /** 素材比剩余时长短时循环（配乐） */
  loop?: boolean
  /** 结尾淡出秒数 */
  fadeOut?: number
  /** 音量包络（成片时间秒，倍数），点之间线性，两端保持端点值；用于对白时压低配乐 */
  envelope?: Array<[number, number]>
}

export interface ComposeCue {
  start: number
  end: number
  text: string
}

export type SubtitleStyle = 'standard' | 'bold' | 'boxed'

/** 合成一个 MP4：画面统一缩放到 width × height（等比加黑边），声音混合，可烧录字幕 */
export interface ComposeSpec {
  width: number
  height: number
  fps: number
  clips: ComposeClip[]
  audio: ComposeAudio[]
  subtitles?: { cues: ComposeCue[]; style: SubtitleStyle }
  /** 镜头之间默认的转场（各段可在 ComposeClip.transition 单独指定） */
  transition?: ComposeTransition
  /** 成片响度标准化到 -14 LUFS（短视频平台的通行响度） */
  loudnorm?: boolean
  /** 输出文件名（不含扩展名） */
  name?: string
}

export interface MediaService {
  probe(ref: AssetRef): Promise<MediaInfo>
  /** 合成视频并存入资产库；进度经 ctx.progress 报告 */
  compose(spec: ComposeSpec): Promise<AssetRef>
}

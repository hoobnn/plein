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

/** 画面上的一段：按顺序首尾相接 */
export interface ComposeClip {
  asset: AssetRef
  /** 入点、出点（秒，相对素材开头）；出点不填到素材结尾 */
  in: number
  out?: number
  /** 素材自带声音的音量，0 为静音 */
  volume: number
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
  /**
   * 镜头之间的转场：fade 经黑场淡出淡入（不改变总时长），
   * dissolve 叠化（相邻镜头重叠 duration 秒，总时长相应缩短）
   */
  transition?: { type: 'fade' | 'dissolve'; duration: number }
  /** 输出文件名（不含扩展名） */
  name?: string
}

export interface MediaService {
  probe(ref: AssetRef): Promise<MediaInfo>
  /** 合成视频并存入资产库；进度经 ctx.progress 报告 */
  compose(spec: ComposeSpec): Promise<AssetRef>
}

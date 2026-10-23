import type { AssetRef } from './ports'

/** 媒体文件的基本信息（ffprobe） */
export interface MediaInfo {
  /** 实际视频流报告的时长；容器时长可能由更长音轨延伸。 */
  videoDuration?: number
  /** 秒 */
  duration?: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec?: string
  hasAlpha?: boolean
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
  provenance?: ClipProvenance
}

export interface MediaResultIdentity {
  canvasId: string
  nodeId: string
  port: string
  resultId: string
  runId: string
}

export interface ClipProvenance {
  clipInstanceId?: string
  segmentId?: string
  source: string
  port?: string
  edgeId?: string
  origin?: MediaResultIdentity
  /** Captured local candidate location, distinct from original execution identity. */
  selection?: MediaResultIdentity
  narrative?: { canvasId: string; boardId: string; shotId: string; historical?: boolean }
}

/** Source seconds and film seconds are different when speed or overlap is used. */
export interface CompositionSource extends ClipProvenance {
  assetId: string
  sourceIn: number
  sourceOut: number
  speed: number
  start: number
  end: number
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

/** 透明视频叠加；几何为成片尺寸的比例，数组后项绘制在前项之上，声音不混入。 */
export interface ComposeOverlay {
  id: string
  asset: AssetRef & { kind: 'video' }
  start: number
  duration: number
  in: number
  speed: number
  x: number
  y: number
  width: number
  height: number
  opacity: number
}

export const SUBTITLE_ORIGINS = ['manual', 'estimated', 'asr', 'legacy'] as const
export type SubtitleOrigin = (typeof SUBTITLE_ORIGINS)[number]

export interface ComposeCue {
  id?: string
  source?: string
  origin?: SubtitleOrigin
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
  overlays?: ComposeOverlay[]
  subtitles?: {
    cues: ComposeCue[]
    style: SubtitleStyle
    /** none 仍保留 cues 供 sidecar；缺省 static 保持旧烧录行为。 */
    render?: 'static' | 'animated' | 'none'
    animation?: 'fade' | 'pop'
  }
  /** 镜头之间默认的转场（各段可在 ComposeClip.transition 单独指定） */
  transition?: ComposeTransition
  /** 成片响度标准化到 -14 LUFS（短视频平台的通行响度） */
  loudnorm?: boolean
  /** 输出文件名（不含扩展名） */
  name?: string
}

/** 所有实际媒体引用；保留每处引用的冻结来源身份，调用方可再按资产 id 去重。 */
export const composeAssetRefs = (
  spec: Pick<ComposeSpec, 'clips' | 'audio' | 'overlays'>,
): AssetRef[] => [
  ...spec.clips.map((clip) => clip.asset),
  ...spec.audio.map((audio) => audio.asset),
  ...(spec.overlays ?? []).map((overlay) => overlay.asset),
]

export interface MediaService {
  probe(ref: AssetRef): Promise<MediaInfo>
  /** 合成视频并存入资产库；进度经 ctx.progress 报告 */
  compose(spec: ComposeSpec): Promise<AssetRef>
  /** Local shot analysis, where supported by the host. The caller validates the versioned manifest. */
  analyzeVideo?(ref: AssetRef, options: VideoAnalysisOptions): Promise<unknown>
  /** Free local technical inspection; never calls a model or confirms delivery. */
  checkVideo?(ref: AssetRef, request: DeliveryCheckRequest): Promise<unknown>
  /** 只渲染宿主内置模板；不接受任意 HTML、代码或本机路径。 */
  renderComposition?(spec: {
    params: Record<string, unknown>
    image?: AssetRef
    video?: AssetRef
  }): Promise<AssetRef>
}

export interface SubtitlePlanEvidence {
  version: 1
  basis: 'executed-sequence-spec'
  enabled: boolean
  cues: ComposeCue[]
}
export interface DeliveryCheckRequest {
  scope: { canvasId: string; boardId: string; sequenceId: string }
  deliveryId: string
  runId: string
  resultId: string
  source: AssetRef
  goal: { id: string; snapshot: string }
  subtitles?: SubtitlePlanEvidence & { assetId: string; resultId: string }
}

export interface VideoAnalysisOptions {
  threshold: number
  minSceneSeconds: number
  points?: number[]
  clips: boolean
  audio: boolean
}

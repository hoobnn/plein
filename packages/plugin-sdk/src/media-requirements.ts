import type { MediaRequirement, MediaRequirements } from './provider'

/**
 * 素材要求的判定：纯函数，不读文件、不联网。
 * 同一份声明（模型 `limits.media`）被两处使用——
 * 适配器提交前按它挡一次，宿主在运行前按它提前提醒。
 */

/** 一条素材的实际信息 */
export interface MediaSample {
  mime?: string
  /** 字节 */
  size?: number
  width?: number
  height?: number
  /** 秒 */
  duration?: number
  /** ffprobe 的视频编码名 */
  videoCodec?: string
  /** 实际帧率 */
  frameRate?: number
  /** 音轨编码列表；空数组表示无音轨 */
  audioCodecs?: string[]
}

export interface MediaCheckOptions {
  /** 模型显示名（spec.title）；说清是哪个模型的要求 */
  title: string
  /** 素材类别：参考图片 / 参考视频 / 参考音频 / 精修原图 */
  label: string
  /** 素材名称（画布上的名字） */
  name?: string
  /**
   * 严格模式：尺寸、时长、编码等信息读不到时也算不满足（适配器提交前用）；
   * 宽松模式（默认）：读不到就跳过这条检查，交给运行期判断
   */
  strict?: boolean
}

/** 一批同类素材的检查输入 */
export interface MediaBatchCheck extends MediaCheckOptions {
  requirement?: MediaRequirement
  samples: Array<{ sample: MediaSample; name?: string }>
  /** 输出的时长（秒）；与参考视频总时长一起受 totalWithOutputMax 限制 */
  outputDuration?: number
  /** 输出时长由模型决定（自适应时长或 -1）：这时不与参考素材的总时长相加 */
  outputDurationByModel?: boolean
}

const MIME_NAMES: Record<string, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'image/bmp': 'BMP',
  'image/tiff': 'TIFF',
  'image/gif': 'GIF',
  'image/heic': 'HEIC',
  'image/heif': 'HEIF',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
  'audio/mpeg': 'MP3',
  'audio/mp3': 'MP3',
}

const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  vp9: 'VP9',
  av1: 'AV1',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  pcm_s16le: 'PCM',
  pcm_s24le: 'PCM',
}

const mimeName = (mime: string) => MIME_NAMES[mime.toLowerCase()] ?? mime
const codecName = (codec: string) => CODEC_NAMES[codec.toLowerCase()] ?? codec

/** 数字最多留三位小数，去掉多余的零 */
const num = (value: number) => String(Math.round(value * 1000) / 1000)

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 宽高范围的文案 */
const edgeText = (requirement: MediaRequirement) => {
  const { minEdge, maxEdge } = requirement
  if (minEdge !== undefined && maxEdge !== undefined) return `${minEdge}–${maxEdge}`
  if (minEdge !== undefined) return `不小于 ${minEdge}`
  return `不超过 ${maxEdge}`
}

/** 宽高比的范围文案 */
const ratioText = (requirement: MediaRequirement) => {
  const { minRatio, maxRatio } = requirement
  if (minRatio !== undefined && maxRatio !== undefined) return `${minRatio}–${maxRatio}`
  if (minRatio !== undefined) return `不小于 ${minRatio}`
  return `不超过 ${maxRatio}`
}

/** 帧率的范围文案 */
const frameRateText = (requirement: MediaRequirement) => {
  const { minFrameRate, maxFrameRate } = requirement
  if (minFrameRate !== undefined && maxFrameRate !== undefined)
    return `${minFrameRate}–${maxFrameRate}`
  if (minFrameRate !== undefined) return `不低于 ${minFrameRate}`
  return `不高于 ${maxFrameRate}`
}

/** 素材的说法：带名字时写「参考视频「片头」」，否则只写类别 */
const who = (label: string, name?: string) => (name ? `${label}「${name}」` : label)

/** 单条素材的要求判定；返回中文问题清单，空数组表示满足 */
export function mediaRequirementProblems(
  requirement: MediaRequirement | undefined,
  sample: MediaSample,
  opts: MediaCheckOptions,
): string[] {
  if (!requirement) return []
  const problems: string[] = []
  const subject = who(opts.label, opts.name)
  const title = opts.title

  if (requirement.mime?.length) {
    const mime = sample.mime?.toLowerCase()
    if (mime && !requirement.mime.includes(mime))
      problems.push(
        `${subject}格式 ${mime} 不在允许范围（${requirement.mime.map(mimeName).join('、')}），请先转换格式再运行`,
      )
    else if (!mime && opts.strict)
      problems.push(`${subject}缺少可读取的格式信息，无法确认是否符合 ${title} 的要求`)
  }

  if (finite(sample.size) && requirement.maxMB !== undefined) {
    const mb = sample.size / 1024 / 1024
    const over = requirement.maxMBExclusive ? mb >= requirement.maxMB : mb > requirement.maxMB
    if (over)
      problems.push(
        `${subject}大小 ${num(mb)} MB，超过 ${title} 的 ${requirement.maxMB} MB 上限，请压缩后再运行`,
      )
  }

  const hasSize =
    finite(sample.width) &&
    finite(sample.height) &&
    Number.isInteger(sample.width) &&
    Number.isInteger(sample.height)
  const checksSize =
    requirement.minEdge !== undefined ||
    requirement.maxEdge !== undefined ||
    requirement.minPixels !== undefined ||
    requirement.maxPixels !== undefined ||
    requirement.minRatio !== undefined ||
    requirement.maxRatio !== undefined
  if (checksSize) {
    if (!hasSize) {
      if (opts.strict)
        problems.push(`${subject}缺少可读取的尺寸信息，无法确认是否符合 ${title} 的要求`)
    } else {
      const width = sample.width as number
      const height = sample.height as number
      const sizeText = `${width}×${height}`
      if (requirement.minEdge !== undefined || requirement.maxEdge !== undefined) {
        const tooSmall =
          requirement.minEdge !== undefined &&
          (width < requirement.minEdge || height < requirement.minEdge)
        const tooLarge =
          requirement.maxEdge !== undefined &&
          (width > requirement.maxEdge || height > requirement.maxEdge)
        if (tooSmall || tooLarge)
          problems.push(
            `${subject} ${sizeText}，${title} 要求宽高 ${edgeText(requirement)} 像素，请更换素材`,
          )
      }
      if (requirement.minRatio !== undefined || requirement.maxRatio !== undefined) {
        const ratio = width / height
        if (
          (requirement.minRatio !== undefined && ratio < requirement.minRatio) ||
          (requirement.maxRatio !== undefined && ratio > requirement.maxRatio)
        )
          problems.push(
            `${subject} ${sizeText}，宽高比 ${num(ratio)}，${title} 要求宽高比 ${ratioText(requirement)}，请更换素材`,
          )
      }
      if (requirement.minPixels !== undefined || requirement.maxPixels !== undefined) {
        const pixels = width * height
        if (
          (requirement.minPixels !== undefined && pixels < requirement.minPixels) ||
          (requirement.maxPixels !== undefined && pixels > requirement.maxPixels)
        )
          problems.push(
            `${subject} ${sizeText}，总像素 ${pixels}，${title} 要求总像素 ${
              requirement.minPixels !== undefined && requirement.maxPixels !== undefined
                ? `${requirement.minPixels}–${requirement.maxPixels}`
                : requirement.minPixels !== undefined
                  ? `不小于 ${requirement.minPixels}`
                  : `不超过 ${requirement.maxPixels}`
            }，请更换素材`,
          )
      }
    }
  }

  if (requirement.minDuration !== undefined || requirement.maxDuration !== undefined) {
    const duration = sample.duration
    if (!finite(duration) || duration <= 0) {
      if (opts.strict)
        problems.push(`${subject}缺少可读取的有效时长，无法确认是否符合 ${title} 的要求`)
    } else {
      if (
        requirement.minDuration !== undefined &&
        requirement.minDuration > 0 &&
        duration < requirement.minDuration
      )
        problems.push(
          `${subject}只有 ${num(duration)} 秒，${title} 要求至少 ${requirement.minDuration} 秒，请换更长的素材`,
        )
      if (requirement.maxDuration !== undefined && duration > requirement.maxDuration)
        problems.push(
          `${subject}时长 ${num(duration)} 秒，超过 ${title} 的 ${requirement.maxDuration} 秒上限，请换更短的素材`,
        )
    }
  }

  if (requirement.videoCodecs?.length) {
    const codec = sample.videoCodec?.toLowerCase()
    if (!codec) {
      if (opts.strict)
        problems.push(`${subject}缺少可读取的编码信息，无法确认是否符合 ${title} 的要求`)
    } else if (!requirement.videoCodecs.includes(codec))
      problems.push(
        `${subject}编码 ${codecName(codec)}，${title} 只接受 ${requirement.videoCodecs
          .map(codecName)
          .join('、')}，请先转码再运行`,
      )
  }

  if (requirement.minFrameRate !== undefined || requirement.maxFrameRate !== undefined) {
    const fps = sample.frameRate
    if (!finite(fps)) {
      if (opts.strict)
        problems.push(`${subject}缺少可读取的帧率信息，无法确认是否符合 ${title} 的要求`)
    } else if (
      (requirement.minFrameRate !== undefined && fps < requirement.minFrameRate) ||
      (requirement.maxFrameRate !== undefined && fps > requirement.maxFrameRate)
    )
      problems.push(
        `${subject}帧率 ${num(fps)} fps，${title} 要求 ${frameRateText(requirement)} fps，请先转码再运行`,
      )
  }

  if (requirement.audioCodecs?.length) {
    const codecs = sample.audioCodecs
    if (!codecs) {
      if (opts.strict)
        problems.push(`${subject}缺少可读的音轨信息，无法确认是否符合 ${title} 的要求`)
    } else {
      const pcmAllowed = (requirement.pcmAudioMimes ?? []).includes(
        sample.mime?.toLowerCase() ?? '',
      )
      const rejected = codecs.filter(
        (codec) =>
          !requirement.audioCodecs!.includes(codec.toLowerCase()) &&
          !(pcmAllowed && codec.toLowerCase().startsWith('pcm_')),
      )
      if (rejected.length)
        problems.push(
          `${subject}音轨编码 ${rejected.map(codecName).join('、')}，${title} 只接受 ${requirement.audioCodecs
            .map(codecName)
            .join('、')}，请先转码再运行`,
        )
    }
  }

  return problems
}

/** 一批同类素材的判定：逐条检查 + 合计时长检查 */
export function mediaBatchProblems(batch: MediaBatchCheck): string[] {
  const problems = batch.samples.flatMap(({ sample, name }) =>
    mediaRequirementProblems(batch.requirement, sample, { ...batch, name: name ?? batch.name }),
  )
  const requirement = batch.requirement
  if (!requirement) return problems
  const total = batch.samples.reduce(
    (sum, { sample }) =>
      sum + (finite(sample.duration) && sample.duration > 0 ? sample.duration : 0),
    0,
  )
  if (requirement.totalDurationMax !== undefined && total > requirement.totalDurationMax)
    problems.push(
      `${batch.label}总时长 ${num(total)} 秒，超过 ${batch.title} 的 ${requirement.totalDurationMax} 秒上限，请缩短素材`,
    )
  if (
    requirement.totalWithOutputMax !== undefined &&
    batch.samples.length > 0 &&
    batch.outputDurationByModel !== true &&
    (finite(batch.outputDuration) || requirement.outputDurationDefault !== undefined)
  ) {
    const output = finite(batch.outputDuration)
      ? batch.outputDuration
      : (requirement.outputDurationDefault as number)
    if (total + output > requirement.totalWithOutputMax)
      problems.push(
        `${batch.label}总时长 ${num(total)} 秒，加输出时长 ${num(output)} 秒，超过 ${batch.title} 的 ${requirement.totalWithOutputMax} 秒上限，请缩短素材或减少输出时长`,
      )
  }
  return problems
}

/** 合并两份要求：override 里声明过的项覆盖 base */
export function mergeMediaRequirement(
  base: MediaRequirement | undefined,
  override: MediaRequirement | undefined,
): MediaRequirement | undefined {
  if (!base) return override
  if (!override) return base
  const merged: MediaRequirement = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  return merged
}

/** 取某类素材的要求；带上任务模式的追加要求（如编辑参考视频的最短时长） */
export function mediaRequirementOf(
  requirements: MediaRequirements | undefined,
  kind: 'image' | 'video' | 'audio' | 'process' | 'frame',
  task?: string,
): MediaRequirement | undefined {
  if (!requirements) return undefined
  // 首尾帧没单独声明时按参考图的要求
  const base = kind === 'frame' ? (requirements.frame ?? requirements.image) : requirements[kind]
  if (kind !== 'video' || !task) return base
  return mergeMediaRequirement(base, requirements.videoTasks?.[task])
}

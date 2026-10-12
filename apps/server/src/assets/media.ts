import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'

const run = promisify(execFile)

export interface Probe {
  width?: number
  height?: number
  /** 秒 */
  duration?: number
  hasVideo: boolean
  hasAudio: boolean
}

const bin = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
let ffmpegAvailable: Promise<boolean> | null = null
let capsCache: Promise<MediaCaps> | null = null

/** 指定 ffmpeg / ffprobe 可执行文件；默认从 PATH 查找 */
export function setMediaTools(paths: { ffmpeg: string; ffprobe: string }) {
  if (paths.ffmpeg === bin.ffmpeg && paths.ffprobe === bin.ffprobe) return
  Object.assign(bin, paths)
  ffmpegAvailable = null
  capsCache = null
}

/** 当前使用的 ffmpeg 可执行文件 */
export const ffmpegBin = () => bin.ffmpeg

/** ffmpeg / ffprobe 是否可用；缺失时视频和音频只存原文件，不生成衍生物 */
export function hasFfmpeg(): Promise<boolean> {
  ffmpegAvailable ??= Promise.all([
    run(bin.ffmpeg, ['-version']),
    run(bin.ffprobe, ['-version']),
  ]).then(
    () => true,
    () => false,
  )
  return ffmpegAvailable
}

/** 本机 ffmpeg 能做什么：烧字幕需要 libass（Homebrew 默认没有，Docker 镜像里有） */
export interface MediaCaps {
  ffmpeg: boolean
  /** 有 `ass` 滤镜，能把字幕烧进画面 */
  subtitles: boolean
  /** 有 `rubberband` 滤镜，音频变速能真正保音调（Homebrew 默认没有） */
  rubberband: boolean
}

/**
 * 探测 ffmpeg 的滤镜能力。缺少 libass 时序列导出要提前给可执行的提示，
 * 不能等合成跑完才抛一句 “Error parsing a filter description”。
 */
export function mediaCaps(): Promise<MediaCaps> {
  capsCache ??= run(bin.ffmpeg, ['-hide_banner', '-filters']).then(
    ({ stdout }) => ({
      ffmpeg: true,
      subtitles: /^\s*\S+\s+ass\s/m.test(stdout) || /^\s*\S+\s+subtitles\s/m.test(stdout),
      rubberband: /^\s*\S+\s+rubberband\s/m.test(stdout),
    }),
    () => ({ ffmpeg: false, subtitles: false, rubberband: false }),
  )
  return capsCache
}

/** 缺能力时给用户看的话：说清缺什么、怎么解决 */
export function missingCapability(cap: 'subtitles'): string {
  return cap === 'subtitles'
    ? '本机 ffmpeg 不支持烧字幕（缺少 ass 滤镜，通常是没装 libass）。关掉字幕后重试，或换成带 libass 的 ffmpeg / 直接用 Docker 镜像。'
    : '本机缺少该 ffmpeg 能力'
}

export async function probeImage(file: string): Promise<Probe> {
  const meta = await sharp(file).metadata()
  // EXIF 方向为 5–8 时宽高互换
  const rotated = (meta.orientation ?? 1) >= 5
  return {
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
    hasVideo: false,
    hasAudio: false,
  }
}

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
  disposition?: { attached_pic?: number }
  side_data_list?: { rotation?: number }[]
  tags?: { rotate?: string }
}

export async function probeMedia(file: string): Promise<Probe> {
  const { stdout } = await run(bin.ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ])
  const info = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string } }
  const streams = info.streams ?? []
  // 音频文件里的封面图也是 video 流，排除掉
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.some((s) => s.codec_type === 'audio')
  const duration = Number(info.format?.duration)
  const rotation = Math.abs(
    Number(
      video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
        video?.tags?.rotate ??
        0,
    ),
  )
  const swap = rotation === 90 || rotation === 270
  return {
    width: swap ? video?.height : video?.width,
    height: swap ? video?.width : video?.height,
    duration: Number.isFinite(duration) ? duration : undefined,
    hasVideo: Boolean(video),
    hasAudio: audio,
  }
}

/** 图片缩略图：限制长边，统一 webp */
export async function imageThumb(src: string, out: string, size: number) {
  await sharp(src)
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(out)
}

/** 视频封面：取第 1 秒（短于 1 秒取首帧），长边 1024 */
export async function videoPoster(src: string, out: string, duration?: number) {
  const at = duration !== undefined && duration < 2 ? '0' : '1'
  const { stdout } = await run(
    bin.ffmpeg,
    ['-v', 'error', '-ss', at, '-i', src, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  )
  await sharp(stdout)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(out)
}

/** 音频波形：透明底 png，画布上当作音频元素的预览 */
export async function audioWaveform(src: string, out: string) {
  await run(bin.ffmpeg, [
    '-v',
    'error',
    '-y',
    '-i',
    src,
    '-filter_complex',
    'aformat=channel_layouts=mono,showwavespic=s=1024x256:colors=0x6366f1',
    '-frames:v',
    '1',
    '-f',
    'image2',
    '-c:v',
    'png',
    out,
  ])
}

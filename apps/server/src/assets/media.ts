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

let ffmpegAvailable: Promise<boolean> | null = null

/** ffmpeg / ffprobe 是否可用；缺失时视频和音频只存原文件，不生成衍生物 */
export function hasFfmpeg(): Promise<boolean> {
  ffmpegAvailable ??= Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]).then(
    () => true,
    () => false,
  )
  return ffmpegAvailable
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
  const { stdout } = await run('ffprobe', [
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
    'ffmpeg',
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
  await run('ffmpeg', [
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

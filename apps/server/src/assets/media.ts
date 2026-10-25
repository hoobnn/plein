import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, type ExecFileOptions } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import sharp from 'sharp'

const runDefault = promisify(execFile)
const mediaAbort = new AsyncLocalStorage<{
  signal: AbortSignal
  ffmpegAvailable?: Promise<boolean>
  h264Cache?: Promise<string[] | null>
  capsCache?: Promise<MediaCaps>
}>()

/** Opt-in cancellation scope, with job-local probe caches, for a complete local media task. */
export function withMediaAbort<T>(signal: AbortSignal, task: () => Promise<T>) {
  return mediaAbort.run({ signal }, task)
}

const run = ((file: string, args: readonly string[], options: ExecFileOptions = {}) => {
  const signal = mediaAbort.getStore()?.signal
  if (!signal) return runDefault(file, args, options)
  signal.throwIfAborted()
  return new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolve, reject) => {
    let output: { stdout: string | Buffer; stderr: string | Buffer } | undefined
    let failure: unknown
    const child = execFile(
      file,
      args,
      { ...options, signal, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        failure = error
        output = { stdout, stderr }
      },
    )
    // AbortError may arrive before close: keep the slot and temporary files until the child exits.
    child.once('close', () => {
      if (signal.aborted) reject(signal.reason)
      else if (failure) reject(failure)
      else if (output) resolve(output)
      else reject(new Error('媒体子进程未返回输出'))
    })
  })
}) as typeof runDefault

export interface Probe {
  /** Video stream duration, when declared separately from the container duration. */
  videoDuration?: number
  videoCodec?: string
  frameRate?: number
  audioCodecs?: string[]
  width?: number
  height?: number
  /** 秒 */
  duration?: number
  hasVideo: boolean
  hasAudio: boolean
  /** 唯一音频流的真实声道数；未知或多音频流时省略。 */
  audioChannels?: number
  /** 唯一音频流的真实采样率（Hz）；未知或多音频流时省略。 */
  audioSampleRate?: number
}

const bin = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
let ffmpegAvailable: Promise<boolean> | null = null
let capsCache: Promise<MediaCaps> | null = null
let h264Cache: Promise<string[] | null> | null = null

/** 指定 ffmpeg / ffprobe 可执行文件；默认从 PATH 查找 */
export function setMediaTools(paths: { ffmpeg: string; ffprobe: string }) {
  if (paths.ffmpeg === bin.ffmpeg && paths.ffprobe === bin.ffprobe) return
  Object.assign(bin, paths)
  ffmpegAvailable = null
  capsCache = null
  h264Cache = null
}

/**
 * 输出 H.264 的编码参数。优先 libx264；桌面安装包附带的是 LGPL 构建，没有 libx264，
 * macOS 上改用系统的 VideoToolbox（硬件编码，不可用时 allow_sw 退到 Apple 的软件编码）。
 */
export function h264Args(): Promise<string[]> {
  const context = mediaAbort.getStore()
  const detect = () =>
    run(bin.ffmpeg, ['-hide_banner', '-encoders']).then(
      ({ stdout }) => {
        if (/^\s*V\S*\s+libx264\s/m.test(stdout))
          return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']
        if (/^\s*V\S*\s+h264_videotoolbox\s/m.test(stdout))
          // VideoToolbox 的恒定质量（-q:v）只有 Apple 芯片支持，统一按码率
          return [
            '-c:v',
            'h264_videotoolbox',
            '-allow_sw',
            '1',
            '-b:v',
            '12M',
            '-maxrate',
            '20M',
            '-bufsize',
            '24M',
          ]
        return null
      },
      () => {
        context?.signal.throwIfAborted()
        return null
      },
    )
  const pending = context ? (context.h264Cache ??= detect()) : (h264Cache ??= detect())
  return pending.then((args) => {
    if (!args)
      throw new Error('本机 ffmpeg 没有 H.264 编码器（libx264 或 VideoToolbox），无法输出视频')
    return [...args, '-pix_fmt', 'yuv420p']
  })
}

/** 当前使用的 ffmpeg 可执行文件 */
export const ffmpegBin = () => bin.ffmpeg

/** ffmpeg / ffprobe 是否可用；缺失时视频和音频只存原文件，不生成衍生物 */
export function hasFfmpeg(): Promise<boolean> {
  const context = mediaAbort.getStore()
  const detect = () =>
    Promise.all([run(bin.ffmpeg, ['-version']), run(bin.ffprobe, ['-version'])]).then(
      () => true,
      () => {
        context?.signal.throwIfAborted()
        return false
      },
    )
  return context ? (context.ffmpegAvailable ??= detect()) : (ffmpegAvailable ??= detect())
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
  const context = mediaAbort.getStore()
  const detect = () =>
    run(bin.ffmpeg, ['-hide_banner', '-filters']).then(
      ({ stdout }) => ({
        ffmpeg: true,
        subtitles: /^\s*\S+\s+ass\s/m.test(stdout) || /^\s*\S+\s+subtitles\s/m.test(stdout),
        rubberband: /^\s*\S+\s+rubberband\s/m.test(stdout),
      }),
      () => {
        context?.signal.throwIfAborted()
        return { ffmpeg: false, subtitles: false, rubberband: false }
      },
    )
  return context ? (context.capsCache ??= detect()) : (capsCache ??= detect())
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
  duration?: string
  codec_type?: string
  codec_name?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  channels?: number
  sample_rate?: string
  width?: number
  height?: number
  disposition?: { attached_pic?: number }
  side_data_list?: { rotation?: number }[]
  tags?: { rotate?: string; DURATION?: string }
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
  const audio = streams.filter((s) => s.codec_type === 'audio')
  const singleAudio = audio.length === 1 ? audio[0] : undefined
  const channels = singleAudio?.channels
  const sampleRate = Number(singleAudio?.sample_rate)
  const duration = Number(info.format?.duration)
  const streamDuration = Number(video?.duration)
  const tag = video?.tags?.DURATION?.match(/^(\d{2,}):([0-5]\d):([0-5]\d(?:\.\d+)?)$/)
  const taggedDuration = tag ? Number(tag[1]) * 3600 + Number(tag[2]) * 60 + Number(tag[3]) : NaN
  const videoDuration =
    Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : taggedDuration
  const rotation = Math.abs(
    Number(
      video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
        video?.tags?.rotate ??
        0,
    ),
  )
  const rate = (value?: string) => {
    if (!value) return undefined
    const [n, d = '1'] = value.split('/')
    const result = Number(n) / Number(d)
    return Number.isFinite(result) && result > 0 ? result : undefined
  }
  const frameRate = rate(video?.avg_frame_rate) ?? rate(video?.r_frame_rate)
  const swap = rotation === 90 || rotation === 270
  return {
    width: swap ? video?.height : video?.width,
    height: swap ? video?.width : video?.height,
    duration: Number.isFinite(duration) ? duration : undefined,
    ...(Number.isFinite(videoDuration) && videoDuration > 0 ? { videoDuration } : {}),
    ...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    audioCodecs: audio.map((stream) => stream.codec_name ?? 'unknown'),
    hasVideo: Boolean(video),
    hasAudio: audio.length > 0,
    ...(channels !== undefined && Number.isInteger(channels) && channels > 0
      ? { audioChannels: channels }
      : {}),
    ...(Number.isInteger(sampleRate) && sampleRate > 0 ? { audioSampleRate: sampleRate } : {}),
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

/**
 * 胶片条：优先按位置快速定位，避免长视频完整解码。
 * 稀疏帧在最后取样点之后可能没有帧；此时顺序解码并在 EOF 复制末帧，填满所有格子。
 */
export async function videoFilmstrip(src: string, out: string, duration: number, frames: number) {
  const args = ['-v', 'error']
  const span = Math.max(0, duration - 0.05)
  for (let k = 0; k < frames; k++)
    args.push('-ss', ((span * (k + 0.5)) / frames).toFixed(3), '-i', src)
  const scaled = Array.from(
    { length: frames },
    (_, k) => `[${k}:v]scale=-2:90,setsar=1,format=rgb24[f${k}]`,
  )
  const stack = `${scaled.map((_, k) => `[f${k}]`).join('')}hstack=inputs=${frames}[out]`
  const output = ['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-']
  const options = { encoding: 'buffer' as const, maxBuffer: 64 * 1024 * 1024 }
  let { stdout } = await run(
    bin.ffmpeg,
    [...args, '-filter_complex', `${scaled.join(';')};${stack}`, '-map', '[out]', ...output],
    options,
  )
  if (!stdout.length) {
    const fallback = await run(
      bin.ffmpeg,
      [
        '-v',
        'error',
        '-i',
        src,
        '-map',
        '0:v:0',
        '-vf',
        `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=-1,fps=${frames}/${duration}:start_time=0:round=near,scale=-2:90,setsar=1,format=rgb24,tile=${frames}x1:nb_frames=${frames}`,
        ...output,
      ],
      options,
    )
    stdout = fallback.stdout
  }
  await sharp(stdout).webp({ quality: 72 }).toFile(out)
}

/** 峰值的采样：单声道 4 kHz 解出来，每 40 个样本取一个峰值，即每秒 100 个 */
const PEAK_SOURCE_RATE = 4000
const PEAK_RATE = 100

/** 音频峰值：时间线上画波形用，比整段解码轻得多 */
export async function audioPeaks(src: string, out: string) {
  const { stdout } = await run(
    bin.ffmpeg,
    [
      '-v',
      'error',
      '-i',
      src,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(PEAK_SOURCE_RATE),
      '-f',
      's16le',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  )
  // Buffer 可能不按 2 字节对齐，逐个读而不是直接套 Int16Array
  const count = Math.floor(stdout.length / 2)
  const step = PEAK_SOURCE_RATE / PEAK_RATE
  const peaks: number[] = []
  for (let i = 0; i < count; i += step) {
    let max = 0
    const end = Math.min(count, i + step)
    for (let j = i; j < end; j++) {
      const v = Math.abs(stdout.readInt16LE(j * 2))
      if (v > max) max = v
    }
    peaks.push(Math.round((max / 32768) * 1000) / 1000)
  }
  await writeFile(out, JSON.stringify({ rate: PEAK_RATE, peaks }))
}

// ── 加工用的底层入口 ──────────────────────────────────

/** 单次 ffmpeg 加工的上限 */
const FFMPEG_TIMEOUT_MS = 10 * 60_000

/** 跑一次 ffmpeg；失败时把 stderr 末尾几行带进消息里，别只丢一句 Command failed */
export function ffmpeg(args: string[], opts: { maxBuffer?: number; timeoutMs?: number } = {}) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      bin.ffmpeg,
      ['-hide_banner', '-v', 'error', '-y', ...args],
      {
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        // 卡死的 ffmpeg 不能一直占着进程；长视频加工也远用不了这么久
        timeout: opts.timeoutMs ?? FFMPEG_TIMEOUT_MS,
      },
      (err, _stdout, stderr) => {
        if (!err) return resolve()
        const tail = String(stderr ?? '')
          .trim()
          .split('\n')
          .slice(-2)
          .join(' ')
        reject(new Error(`ffmpeg 处理失败：${tail || err.message}`))
      },
    )
  })
}

/** 音频流的采样率；取不到时按 48k 处理（重采样滤镜只是改率，不影响时长） */
export async function audioSampleRate(file: string): Promise<number> {
  const { stdout } = await run(bin.ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-select_streams',
    'a:0',
    '-show_streams',
    file,
  ])
  const info = JSON.parse(stdout) as { streams?: { sample_rate?: string }[] }
  return Number(info.streams?.[0]?.sample_rate) || 48000
}

/** atempo 单级只支持 0.5–2，超出时串联（视频变速的音轨、音频变速都用它） */
export function atempoChain(speed: number) {
  const parts: string[] = []
  let s = speed
  while (s > 2) {
    parts.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  parts.push(`atempo=${Number(s.toFixed(4))}`)
  return parts.join(',')
}

/** ffmpeg 参数里的秒，保留三位足够精确又短 */
export const fmtSeconds = (n: number) => Number(n.toFixed(3)).toString()

/**
 * 音频变速滤镜。
 *
 * keepPitch = true：有 rubberband 就用它（相位声码器，真保音调）；本机没有时退到
 * atempo 串联（时域拉伸，音高基本不变，但不是相位声码级质量，倍速很极端时有轻微抖动）。
 * 注意 asetrate 帮不上保音调：asetrate=k 让音高 ×k、时长 ÷k，atempo 只改时长不改音高，
 * 两者串起来音高必然还差一个 k 倍，所以它只能用于“故意变调”的那一种。
 * keepPitch = false：asetrate 直接改采样率，就是常见的“加速变调”。
 */
export function audioTempoFilter(
  speed: number,
  keepPitch: boolean,
  opts: { rubberband: boolean; sampleRate: number },
) {
  const rate = opts.sampleRate || 48000
  if (keepPitch && opts.rubberband) return { filter: `rubberband=tempo=${fmtSeconds(speed)}` }
  if (keepPitch)
    return {
      filter: atempoChain(speed),
      note: '本机 ffmpeg 没有 rubberband 滤镜：已退到 atempo 时域拉伸串联，音高基本保持，但不是相位声码级的完美保音调，倍速很极端时会有轻微失真。',
    }
  return {
    filter: `asetrate=${Math.round(rate * speed)},aresample=${rate}`,
    note: '不保音调：音高会跟着速度一起变（asetrate 直接改采样率）。',
  }
}

/** 抽帧：取指定时刻的一帧写成 png（落在磁盘上，成为可用的图片资产） */
/** 最后一帧：从结尾前一秒起逐帧覆盖写同一个文件，留下的就是最后一帧（按时长算 -ss 常常落在最后一帧之后） */
export async function videoLastFrame(src: string, out: string) {
  await ffmpeg(['-sseof', '-1', '-i', src, '-update', '1', '-c:v', 'png', out])
}

export async function videoFrame(src: string, out: string, at: number) {
  await ffmpeg([
    '-ss',
    fmtSeconds(Math.max(0, at)),
    '-i',
    src,
    '-frames:v',
    '1',
    '-c:v',
    'png',
    out,
  ])
}

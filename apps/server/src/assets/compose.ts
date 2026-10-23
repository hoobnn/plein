import { spawn } from 'node:child_process'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { subtitleAss } from '@plein/nodes'
import {
  type ComposeSpec,
  type ComposeTransition,
  type MediaInfo,
  overlapping,
} from '@plein/plugin-sdk'
import { subtitleFont } from './fonts'
import { atempoChain, ffmpegBin, h264Args } from './media'

const RATE = 48000

/** 每段从素材里取多长（秒，素材时间） */
function sourceLengths(spec: ComposeSpec, infos: MediaInfo[]) {
  return spec.clips.map((c, i) => {
    const total = c.asset.kind === 'image' ? (c.out ?? 1) : (infos[i]?.duration ?? 0)
    const end = Math.min(c.out ?? total, total)
    return Math.max(0, end - c.in)
  })
}

/** 同一转场语义，供字幕层根时长和合成门禁使用。 */
export function compositionDuration(spec: ComposeSpec, infos: MediaInfo[]): number {
  const durations = sourceLengths(spec, infos).map((d, i) => d / (spec.clips[i]!.speed ?? 1))
  return durations.reduce((sum, duration, i) => {
    const tr = i ? (spec.clips[i]!.transition ?? spec.transition) : undefined
    return sum + duration - (tr && overlapping(tr) ? tr.duration : 0)
  }, 0)
}

/** 新图层必须可表示且覆盖真实源窗口；不让损坏数据静默消失或冻结尾帧。 */
export function validateComposeOverlays(
  spec: ComposeSpec,
  infos: MediaInfo[],
  total: number,
  internalCaptionLayer = false,
) {
  const overlays = spec.overlays ?? []
  if (overlays.length > (internalCaptionLayer ? 201 : 200)) throw new Error('叠加层不能超过 200 个')
  overlays.forEach((overlay, i) => {
    const finite = [
      overlay.start,
      overlay.duration,
      overlay.in,
      overlay.speed,
      overlay.x,
      overlay.y,
      overlay.width,
      overlay.height,
      overlay.opacity,
    ].every(Number.isFinite)
    if (
      !finite ||
      overlay.start < 0 ||
      overlay.start >= total ||
      overlay.duration <= 0 ||
      overlay.in < 0 ||
      overlay.speed < 0.25 ||
      overlay.speed > 4 ||
      overlay.x < 0 ||
      overlay.x > 1 ||
      overlay.y < 0 ||
      overlay.y > 1 ||
      overlay.width <= 0 ||
      overlay.width > 1 ||
      overlay.height <= 0 ||
      overlay.height > 1 ||
      overlay.opacity < 0 ||
      overlay.opacity > 1
    )
      throw new Error(`第 ${i + 1} 个叠加层的时间或位置不合法`)
    const info = infos[i]
    if (!info?.hasVideo) throw new Error(`第 ${i + 1} 个叠加层不是视频`)
    const duration = Math.min(overlay.duration, total - overlay.start)
    if (
      !Number.isFinite(info.duration) ||
      overlay.in + duration * overlay.speed > info.duration! + 1 / spec.fps
    )
      throw new Error(`第 ${i + 1} 个叠加层的源素材不足以覆盖入点、速度与可见时长`)
  })
}

const fmt = (n: number) => Number(n.toFixed(3)).toString()

/** 重叠转场对应的 xfade 效果 */
const XFADE: Record<Exclude<ComposeTransition['type'], 'fade'>, string> = {
  dissolve: 'fade',
  wipe: 'wipeleft',
  slide: 'slideleft',
  flash: 'fadewhite',
}

/**
 * 分段线性的音量包络写成 ffmpeg 表达式（t 是这条声音自己的时间，所以减去它在成片里的起点）。
 * 两端保持端点值，和预览的 Web Audio 包络一致。
 */
export function envelopeExpr(env: Array<[number, number]>, offset: number) {
  const pts = env.map(([x, v]) => [x - offset, v] as const)
  let expr = fmt(pts.at(-1)![1])
  for (let i = pts.length - 1; i >= 1; i--) {
    const [x0, v0] = pts[i - 1]!
    const [x1, v1] = pts[i]!
    const seg = x1 > x0 ? `${fmt(v0)}+(${fmt(v1 - v0)})*(t-${fmt(x0)})/${fmt(x1 - x0)}` : fmt(v1)
    expr = `if(lt(t,${fmt(x1)}),${seg},${expr})`
  }
  return `if(lt(t,${fmt(pts[0]![0])}),${fmt(pts[0]![1])},${expr})`
}

/**
 * 组装 ffmpeg 参数。输入顺序：先各段画面，再各段声音。
 * 画面统一缩放加黑边、帧率、像素格式后拼接；每段自带声音按音量保留，没有声音补静音，
 * 再和放在时间线上的配音、配乐、音效混合；有字幕时用 libass 烧录 subs.ass（相对工作目录）。
 */
function composeArgs(
  spec: ComposeSpec,
  files: { clips: string[]; audio: string[]; overlays?: string[] },
  infos: { clips: MediaInfo[]; overlays?: MediaInfo[] },
  out: string,
  /** H.264 编码参数，见 h264Args */
  encoder: string[],
  /** 字幕字体放在工作目录的 fonts/ 里（只给 libass 这一个字体，和预览一致） */
  fontsdir = false,
) {
  const { width: W, height: H, fps } = spec
  const sources = sourceLengths(spec, infos.clips)
  const speeds = spec.clips.map((c) => (c.speed && c.speed > 0 ? c.speed : 1))
  const durations = sources.map((d, i) => d / speeds[i]!)
  const n = spec.clips.length
  // 进入第 i 段的转场：各段自己的优先，没有用全局的；第一段没有
  const transitions = spec.clips.map((c, i) =>
    i > 0 ? (c.transition ?? spec.transition) : undefined,
  )
  const args = ['-hide_banner', '-v', 'error', '-y']
  const filters: string[] = []

  spec.clips.forEach((c, i) => {
    if (c.asset.kind === 'image') args.push('-loop', '1', '-framerate', String(fps))
    args.push('-ss', fmt(c.in), '-t', fmt(sources[i]!), '-i', files.clips[i]!)
  })
  spec.audio.forEach((a, i) => {
    if (a.loop) args.push('-stream_loop', '-1')
    args.push('-i', files.audio[i]!)
  })

  ;(spec.overlays ?? []).forEach((overlay, i) => {
    // FFmpeg内置VP9解码会丢WebM alpha，明确使用libvpx双平面解码。
    if (infos.overlays?.[i]?.videoCodec === 'vp9' && infos.overlays[i]?.hasAlpha)
      args.push('-c:v', 'libvpx-vp9')
    args.push(
      '-ss',
      fmt(overlay.in),
      '-t',
      fmt(overlay.duration * overlay.speed),
      '-i',
      files.overlays![i]!,
    )
  })

  // 经黑场转场：前一段结尾淡出、后一段开头淡入，各占一半
  const fades = (i: number, len: number, kind: 'v' | 'a') => {
    const f = kind === 'v' ? 'fade' : 'afade'
    const into = transitions[i]
    const next = transitions[i + 1]
    let out = ''
    if (into?.type === 'fade') out += `,${f}=t=in:st=0:d=${fmt(into.duration / 2)}`
    if (next?.type === 'fade') {
      const half = next.duration / 2
      out += `,${f}=t=out:st=${fmt(Math.max(0, len - half))}:d=${fmt(half)}`
    }
    return out
  }

  spec.clips.forEach((c, i) => {
    const len = durations[i]!
    const d = fmt(len)
    const speed = speeds[i]!
    const retime = speed !== 1 ? `setpts=(PTS-STARTPTS)/${fmt(speed)},` : ''
    // setpts 会清掉帧率声明；fps 放在它后面，xfade 才能收到恒定帧率与统一的时间基准。
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,${retime}format=yuv420p,trim=duration=${d},setpts=PTS-STARTPTS,fps=${fps}${fades(i, len, 'v')}[v${i}]`,
    )
    if (infos.clips[i]?.hasAudio && c.volume > 0) {
      // 变速不变调（和画面同步拉伸）
      const tempo = speed !== 1 ? `${atempoChain(speed)},` : ''
      filters.push(
        `[${i}:a]aformat=sample_rates=${RATE}:channel_layouts=stereo,volume=${fmt(c.volume)},asetpts=PTS-STARTPTS,${tempo}apad,atrim=duration=${d}${fades(i, len, 'a')}[a${i}]`,
      )
    } else {
      filters.push(`anullsrc=r=${RATE}:cl=stereo,atrim=duration=${d}[a${i}]`)
    }
  })

  // 逐段接上：重叠转场用 xfade / acrossfade，其余直接拼接
  let v = '[v0]'
  let a = '[a0]'
  let total = durations[0] ?? 0
  for (let i = 1; i < n; i++) {
    const tr = transitions[i]
    const last = i === n - 1
    const vo = last ? '[vcat]' : `[vx${i}]`
    const ao = last ? '[acat]' : `[ax${i}]`
    if (tr && overlapping(tr)) {
      // 累计画面可能刚经过 concat（时间基准为微秒），也要重新归一才能和下一段 xfade。
      filters.push(`${v}fps=${fps}[xf${i}]`)
      filters.push(
        `[xf${i}][v${i}]xfade=transition=${XFADE[tr.type as keyof typeof XFADE]}:duration=${fmt(tr.duration)}:offset=${fmt(total - tr.duration)}${vo}`,
      )
      filters.push(`${a}[a${i}]acrossfade=d=${fmt(tr.duration)}${ao}`)
      total += durations[i]! - tr.duration
    } else {
      filters.push(`${v}${a}[v${i}][a${i}]concat=n=2:v=1:a=1${vo}${ao}`)
      total += durations[i]!
    }
    v = vo
    a = ao
  }
  if (n === 1) filters.push('[v0]null[vcat]', '[a0]anull[acat]')

  const mix = ['[acat]']
  spec.audio.forEach((a, j) => {
    const input = spec.clips.length + j
    const room = Math.max(0, total - a.start)
    const length = Math.min(a.duration ?? room, room)
    if (length <= 0) return
    const chain = [
      `aformat=sample_rates=${RATE}:channel_layouts=stereo`,
      `atrim=duration=${fmt(length)}`,
      'asetpts=PTS-STARTPTS',
      `volume=${fmt(a.volume)}`,
    ]
    if (a.envelope?.length) chain.push(`volume='${envelopeExpr(a.envelope, a.start)}':eval=frame`)
    if (a.fadeOut && length > a.fadeOut)
      chain.push(`afade=t=out:st=${fmt(length - a.fadeOut)}:d=${fmt(a.fadeOut)}`)
    const delay = Math.round(a.start * 1000)
    if (delay > 0) chain.push(`adelay=${delay}:all=1`)
    filters.push(`[${input}:a]${chain.join(',')}[m${j}]`)
    mix.push(`[m${j}]`)
  })
  // normalize=0：各轨按设定音量叠加，不因轨数多而整体变小；
  // 响度标准化到 -14 LUFS（单遍动态模式，自带真峰值限制），loudnorm 内部升采样，再降回来。
  // 整条都是补的静音时不标准化：loudnorm 会把纯静音放大成极大的样本值，aac 编码直接失败
  const audible =
    mix.length > 1 || spec.clips.some((c, i) => infos.clips[i]?.hasAudio && c.volume > 0)
  const master =
    spec.loudnorm && audible
      ? `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=${RATE}`
      : mix.length > 1
        ? 'alimiter=limit=0.95'
        : 'anull'
  filters.push(
    mix.length > 1
      ? `${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,${master}[aout]`
      : `[acat]${master}[aout]`,
  )
  let painted = '[vcat]'
  const precise = (value: number) => Number(value.toFixed(9)).toString()
  ;(spec.overlays ?? []).forEach((overlay, i) => {
    const input = spec.clips.length + spec.audio.length + i
    const width = Math.max(1, Math.round(overlay.width * W)),
      height = Math.max(1, Math.round(overlay.height * H))
    const start = precise(overlay.start),
      end = precise(Math.min(total, overlay.start + overlay.duration))
    filters.push(
      `[${input}:v]setpts=(PTS-STARTPTS)/${precise(overlay.speed)},fps=${fps},scale=${width}:${height},format=rgba,colorchannelmixer=aa=${precise(overlay.opacity)},setpts=PTS+${start}/TB[overlay${i}]`,
    )
    filters.push(
      `${painted}[overlay${i}]overlay=x=${Math.round(overlay.x * W)}:y=${Math.round(overlay.y * H)}:enable='gte(t,${start})*lt(t,${end})':eof_action=pass:repeatlast=0:format=auto[paint${i}]`,
    )
    painted = `[paint${i}]`
  })
  filters.push(
    spec.subtitles?.cues.length && (spec.subtitles.render ?? 'static') === 'static'
      ? `${painted}ass=subs.ass${fontsdir ? ':fontsdir=fonts' : ''}[vout]`
      : `${painted}format=yuv420p[vout]`,
  )

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...encoder,
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-t',
    fmt(total),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    out,
  )
  return { args, total }
}

/**
 * 在临时目录里运行 ffmpeg 合成视频，返回输出文件路径。
 * 进度按 out_time 与总时长之比报告；signal 中止时结束 ffmpeg。
 */
export async function composeVideo(
  spec: ComposeSpec,
  files: { clips: string[]; audio: string[]; overlays?: string[] },
  infos: { clips: MediaInfo[]; overlays?: MediaInfo[] },
  dir: string,
  opts: {
    signal: AbortSignal
    onProgress?: (fraction: number) => void
    /** 仅宿主追加的内部字幕层，不占用户的200层额度。 */ internalCaptionLayer?: boolean
  },
) {
  opts.signal.throwIfAborted()
  if (spec.clips.length === 0) throw new Error('没有可合成的画面')
  validateComposeOverlays(
    spec,
    infos.overlays ?? [],
    compositionDuration(spec, infos.clips),
    opts.internalCaptionLayer,
  )
  if ((files.overlays?.length ?? 0) !== (spec.overlays?.length ?? 0))
    throw new Error('叠加层文件不完整')
  const out = join(dir, 'out.mp4')
  let fontsdir = false
  if (spec.subtitles?.cues.length && (spec.subtitles.render ?? 'static') === 'static') {
    const font = await subtitleFont()
    if (font) {
      await mkdir(join(dir, 'fonts'), { recursive: true })
      await symlink(font.file, join(dir, 'fonts', basename(font.file)))
      fontsdir = true
    }
    await writeFile(join(dir, 'subs.ass'), subtitleAss(spec, font?.family))
  }
  const { args, total } = composeArgs(spec, files, infos, out, await h264Args(), fontsdir)
  if (total <= 0) throw new Error('画面总时长为 0，检查各段的入点和出点')
  opts.signal.throwIfAborted()

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin(), args, { cwd: dir, signal: opts.signal })
    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let stderr = ''
    let buf = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
        if (m) opts.onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / total))
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    // AbortSignal 的 error 早于 close；必须等退出后才允许调用方清理工作目录。
    proc.on('error', (error) => {
      failure = error
      if (opts.signal.aborted && proc.pid && !killTimer) {
        killTimer = setTimeout(() => proc.kill('SIGKILL'), 5_000)
        killTimer.unref()
      }
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      if (failure) reject(failure)
      else if (opts.signal.aborted) reject(opts.signal.reason)
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg 合成失败（${code}）：${stderr.trim()}`))
    })
  })
  return { file: out, duration: total }
}

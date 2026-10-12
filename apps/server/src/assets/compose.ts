import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComposeSpec, MediaInfo, SubtitleStyle } from '@plein/plugin-sdk'
import { ffmpegBin } from './media'

const RATE = 48000

/** 每段画面在成片里实际播放的时长 */
function clipDurations(spec: ComposeSpec, infos: MediaInfo[]) {
  return spec.clips.map((c, i) => {
    const total = infos[i]?.duration ?? 0
    const end = Math.min(c.out ?? total, total)
    return Math.max(0, end - c.in)
  })
}

const fmt = (n: number) => Number(n.toFixed(3)).toString()

/**
 * 组装 ffmpeg 参数。输入顺序：先各段画面，再各段声音。
 * 画面统一缩放加黑边、帧率、像素格式后拼接；每段自带声音按音量保留，没有声音补静音，
 * 再和放在时间线上的配音、配乐、音效混合；有字幕时用 libass 烧录 subs.ass（相对工作目录）。
 */
function composeArgs(
  spec: ComposeSpec,
  files: { clips: string[]; audio: string[] },
  infos: { clips: MediaInfo[] },
  out: string,
) {
  const { width: W, height: H, fps } = spec
  const durations = clipDurations(spec, infos.clips)
  const n = spec.clips.length
  const tr = n > 1 ? spec.transition : undefined
  const overlap = tr?.type === 'dissolve' ? tr.duration : 0
  const total = durations.reduce((a, b) => a + b, 0) - overlap * Math.max(0, n - 1)
  const args = ['-hide_banner', '-v', 'error', '-y']
  const filters: string[] = []

  spec.clips.forEach((c, i) => {
    args.push('-ss', fmt(c.in), '-t', fmt(durations[i]!), '-i', files.clips[i]!)
  })
  spec.audio.forEach((a, i) => {
    if (a.loop) args.push('-stream_loop', '-1')
    args.push('-i', files.audio[i]!)
  })

  // 经黑场转场：前一段结尾淡出、后一段开头淡入，各占一半
  const half = tr?.type === 'fade' ? tr.duration / 2 : 0
  const fades = (i: number, len: number, kind: 'v' | 'a') => {
    if (!half) return ''
    const f = kind === 'v' ? 'fade' : 'afade'
    let out = ''
    if (i > 0) out += `,${f}=t=in:st=0:d=${fmt(half)}`
    if (i < n - 1) out += `,${f}=t=out:st=${fmt(Math.max(0, len - half))}:d=${fmt(half)}`
    return out
  }

  spec.clips.forEach((c, i) => {
    const len = durations[i]!
    const d = fmt(len)
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,trim=duration=${d},setpts=PTS-STARTPTS${fades(i, len, 'v')}[v${i}]`,
    )
    if (infos.clips[i]?.hasAudio && c.volume > 0) {
      filters.push(
        `[${i}:a]aformat=sample_rates=${RATE}:channel_layouts=stereo,volume=${fmt(c.volume)},asetpts=PTS-STARTPTS,apad,atrim=duration=${d}${fades(i, len, 'a')}[a${i}]`,
      )
    } else {
      filters.push(`anullsrc=r=${RATE}:cl=stereo,atrim=duration=${d}[a${i}]`)
    }
  })
  if (overlap > 0) {
    // 叠化：画面 xfade、声音 acrossfade，第 k 段在前面各段总长减去 k 次重叠处开始
    let v = '[v0]'
    let a = '[a0]'
    let offset = 0
    for (let i = 1; i < n; i++) {
      offset += durations[i - 1]! - overlap
      const last = i === n - 1
      const vo = last ? '[vcat]' : `[vx${i}]`
      const ao = last ? '[acat]' : `[ax${i}]`
      filters.push(
        `${v}[v${i}]xfade=transition=fade:duration=${fmt(overlap)}:offset=${fmt(offset)}${vo}`,
      )
      filters.push(`${a}[a${i}]acrossfade=d=${fmt(overlap)}${ao}`)
      v = vo
      a = ao
    }
  } else {
    const concat = spec.clips.map((_, i) => `[v${i}][a${i}]`).join('')
    filters.push(`${concat}concat=n=${n}:v=1:a=1[vcat][acat]`)
  }

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
    if (a.fadeOut && length > a.fadeOut)
      chain.push(`afade=t=out:st=${fmt(length - a.fadeOut)}:d=${fmt(a.fadeOut)}`)
    const delay = Math.round(a.start * 1000)
    if (delay > 0) chain.push(`adelay=${delay}:all=1`)
    filters.push(`[${input}:a]${chain.join(',')}[m${j}]`)
    mix.push(`[m${j}]`)
  })
  // normalize=0：各轨按设定音量叠加，不因轨数多而整体变小
  filters.push(
    mix.length > 1
      ? `${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`
      : '[acat]anull[aout]',
  )
  filters.push(spec.subtitles?.cues.length ? '[vcat]ass=subs.ass[vout]' : '[vcat]null[vout]')

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
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

function assTime(t: number) {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** ASS 颜色是 &HAABBGGRR，AA 为透明度 */
const STYLES: Record<
  SubtitleStyle,
  { size: number; bold: number; outline: number; border: number; back: string }
> = {
  standard: { size: 0.05, bold: 0, outline: 0.0025, border: 1, back: '&H80000000' },
  bold: { size: 0.06, bold: 1, outline: 0.004, border: 1, back: '&H80000000' },
  boxed: { size: 0.05, bold: 0, outline: 0.006, border: 3, back: '&H60000000' },
}

/** 生成 ASS 字幕：字号和边距按画面短边换算，中文字体由 fontconfig 兜底 */
function assSubtitles(spec: ComposeSpec) {
  const sub = spec.subtitles!
  const st = STYLES[sub.style]
  const short = Math.min(spec.width, spec.height)
  const size = Math.round(short * st.size)
  const outline = Math.max(1, Math.round(short * st.outline))
  const margin = Math.round(spec.height * (spec.height > spec.width ? 0.12 : 0.07))
  const side = Math.round(spec.width * 0.06)
  const text = (t: string) =>
    t.replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N').trim()
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${spec.width}`,
    `PlayResY: ${spec.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans CJK SC,${size},&H00FFFFFF,&H00FFFFFF,${st.border === 3 ? st.back : '&H00000000'},${st.back},${st.bold ? -1 : 0},0,0,0,100,100,0,0,${st.border},${outline},0,2,${side},${side},${margin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...sub.cues
      .filter((c) => c.end > c.start && c.text.trim())
      .map(
        (c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${text(c.text)}`,
      ),
    '',
  ].join('\n')
}

/**
 * 在临时目录里运行 ffmpeg 合成视频，返回输出文件路径。
 * 进度按 out_time 与总时长之比报告；signal 中止时结束 ffmpeg。
 */
export async function composeVideo(
  spec: ComposeSpec,
  files: { clips: string[]; audio: string[] },
  infos: { clips: MediaInfo[] },
  dir: string,
  opts: { signal: AbortSignal; onProgress?: (fraction: number) => void },
) {
  if (spec.clips.length === 0) throw new Error('没有可合成的画面')
  const out = join(dir, 'out.mp4')
  if (spec.subtitles?.cues.length) await writeFile(join(dir, 'subs.ass'), assSubtitles(spec))
  const { args, total } = composeArgs(spec, files, infos, out)
  if (total <= 0) throw new Error('画面总时长为 0，检查各段的入点和出点')

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBin(), args, { cwd: dir, signal: opts.signal })
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
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(`ffmpeg 合成失败（${code}）：${stderr.trim().split('\n').slice(-3).join(' ')}`),
        )
    })
  })
  return { file: out, duration: total }
}

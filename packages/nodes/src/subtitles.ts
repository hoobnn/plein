import type { ComposeSpec, SubtitleStyle } from '@plein/plugin-sdk'

export const DEFAULT_SUBTITLE_FONT = 'Noto Sans CJK SC'

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

/**
 * 生成 ASS 字幕：字号和边距按画面短边换算。导出（ffmpeg 的 libass）和预览（JASSUB）共用，
 * font 是两边都加载的同一个字体文件的族名；没有时写 Noto Sans CJK SC，由系统字体兜底。
 */
export function subtitleAss(
  spec: Pick<ComposeSpec, 'width' | 'height' | 'subtitles'>,
  font = DEFAULT_SUBTITLE_FONT,
) {
  const sub = spec.subtitles ?? { cues: [], style: 'standard' as const }
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
    `Style: Default,${font},${size},&H00FFFFFF,&H00FFFFFF,${st.border === 3 ? st.back : '&H00000000'},${st.back},${st.bold ? -1 : 0},0,0,0,100,100,0,0,${st.border},${outline},0,2,${side},${side},${margin},1`,
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

import { z } from 'zod'

export const CAPTION_TEMPLATE_VERSION = 1
const dimension = z
  .number()
  .int()
  .min(16)
  .max(3840)
  .refine((v) => v % 2 === 0, '尺寸必须是偶数')
export const CaptionLayerParams = z
  .object({
    width: dimension,
    height: dimension,
    fps: z.literal(30).default(30),
    duration: z
      .number()
      .min(1 / 30)
      .max(300),
    cues: z
      .array(
        z
          .object({
            id: z.string().max(500).optional(),
            source: z.string().max(500).optional(),
            origin: z.enum(['manual', 'estimated', 'asr', 'legacy']).optional(),
            start: z.number().min(0).max(300),
            end: z.number().min(0).max(300),
            text: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(2000),
    style: z.enum(['standard', 'bold', 'boxed']).default('standard'),
    animation: z.enum(['fade', 'pop']).default('fade'),
  })
  .strict()
  .superRefine((params, ctx) => {
    const frames = Math.round(params.duration * 30)
    if (params.cues.reduce((total, cue) => total + cue.text.length, 0) > 100_000)
      ctx.addIssue({ code: 'custom', path: ['cues'], message: '字幕总文本超过 100000 字符' })
    params.cues.forEach((cue, index) => {
      if (
        cue.end > params.duration ||
        cue.start >= cue.end ||
        Math.round(cue.start * 30) >= Math.round(cue.end * 30) ||
        Math.round(cue.end * 30) > frames
      )
        ctx.addIssue({
          code: 'custom',
          path: ['cues', index, 'end'],
          message: '字幕窗口应位于序列时长内，且至少一帧',
        })
    })
  })
export type CaptionLayerParams = z.output<typeof CaptionLayerParams>
export const captionDurationFrames = (params: Pick<CaptionLayerParams, 'duration'>) =>
  Math.round(params.duration * 30)

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  )
function localFile(path: string) {
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,499}$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('字幕依赖必须是包内本地相对路径')
  return path
}

/** Cue-level animation only: original timestamps and provenance stay in the source manifest. */
export function captionLayerHtml(
  input: CaptionLayerParams,
  files: { gsap?: string; fontCss?: string } = {},
): string {
  const params = CaptionLayerParams.parse(input)
  const gsap = localFile(files.gsap ?? 'vendor/gsap.min.js')
  const fontCss = localFile(files.fontCss ?? 'fonts/noto-sans-sc.css')
  const duration = captionDurationFrames(params) / 30
  const fontSize = Math.max(16, Math.round(Math.min(params.width * 0.052, params.height * 0.065)))
  const cues = params.cues
    .map((cue, index) => {
      const start = Math.round(cue.start * 30) / 30,
        end = Math.round(cue.end * 30) / 30
      return `<div id="hf-caption-${index}" data-hf-id="hf-caption-${index}" class="clip caption" data-start="${start}" data-end="${end}" data-duration="${end - start}" data-track-index="${index}"><span>${escapeHtml(cue.text)}</span></div>`
    })
    .join('\n')
  const animation = params.cues
    .map((cue, index) => {
      const start = Math.round(cue.start * 30) / 30,
        end = Math.round(cue.end * 30) / 30
      const fade = Math.min(0.15, (end - start) / 3)
      const from = params.animation === 'pop' ? '{opacity:0,scale:0.92,y:8}' : '{opacity:0}'
      const to =
        params.animation === 'pop'
          ? '{opacity:1,scale:1,y:0,ease:"back.out(1.3)"'
          : '{opacity:1,ease:"none"'
      return `tl.fromTo('#hf-caption-${index}',${from},${to},duration:${fade}},${start});tl.to('#hf-caption-${index}',{opacity:0,duration:${fade},ease:'none'},${end - fade});`
    })
    .join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${fontCss}"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#hf-root{position:relative;width:${params.width}px;height:${params.height}px;overflow:hidden;background:transparent;font-family:'Noto Sans SC',Arial,sans-serif}.caption{position:absolute;left:5%;width:90%;bottom:7%;margin:0;opacity:0;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;font-size:${fontSize}px;font-weight:${params.style === 'bold' ? 700 : 400};line-height:1.35;color:#ffffff;transform-origin:center bottom}.caption span{box-decoration-break:clone;-webkit-box-decoration-break:clone;${params.style === 'boxed' ? 'background:#111827e6;border-radius:8px;padding:4px 12px;' : 'text-shadow:0 2px 3px #000000,0 0 6px #000000;'}}
</style></head><body><main id="hf-root" data-hf-id="hf-root" data-hf-root data-composition-id="plein-captions" data-start="0" data-duration="${duration}" data-width="${params.width}" data-height="${params.height}">${cues}</main><script src="${gsap}"></script><script>const tl=gsap.timeline({paused:true});
${animation}
tl.to({}, {duration:${duration}}, 0);window.__timelines=window.__timelines||{};window.__timelines['plein-captions']=tl;</script></body></html>`
}

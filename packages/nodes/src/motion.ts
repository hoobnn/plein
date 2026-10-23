import { defineNode } from '@plein/plugin-sdk'
import { z } from 'zod'

export const MOTION_TYPE = 'plein/motion'
export const MOTION_FPS = 30
export const MOTION_TEMPLATE_VERSION = 1
export const MOTION_TEMPLATES = ['title', 'character', 'video-title'] as const
export const MOTION_TEMPLATE_LABELS = {
  title: '片头 / 章节卡',
  character: '角色介绍',
  'video-title': '视频标题包装',
} as const

const color = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i, '请使用十六进制颜色')
const elementIds = ['hf-title', 'hf-subtitle', 'hf-accent', 'hf-media'] as const
export type MotionElementId = (typeof elementIds)[number]
const textStyles = ['color', 'fontSize', 'left', 'top', 'width', 'opacity'] as const
const boxStyles = ['left', 'top', 'width', 'height', 'opacity', 'borderRadius'] as const
export const motionEditable = [
  { id: 'hf-title', label: '标题', text: true, styles: textStyles, timing: true },
  { id: 'hf-subtitle', label: '副标题', text: true, styles: textStyles, timing: true },
  {
    id: 'hf-accent',
    label: '装饰线',
    text: false,
    styles: ['backgroundColor', ...boxStyles],
    timing: true,
  },
  { id: 'hf-media', label: '图片 / 视频', text: false, styles: boxStyles, timing: true },
] as const

function styleProblem(property: string, value: unknown): string | undefined {
  if (typeof value !== 'string') return '样式值必须是字符串'
  if (property === 'color' || property === 'backgroundColor')
    return color.safeParse(value).success ? undefined : '请使用十六进制颜色'
  if (property === 'opacity')
    return /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(value) ? undefined : '透明度应在 0–1 之间'
  const match = /^(-?\d+(?:\.\d{1,3})?)(px|%)$/.exec(value)
  if (!match) return '尺寸仅支持数值 px 或 %'
  const n = Number(match[1])
  const unit = match[2]
  if (property === 'fontSize')
    return unit === 'px' && n >= 12 && n <= 240 ? undefined : '字号应在 12–240 px 之间'
  if (property === 'left' || property === 'top')
    return Math.abs(n) <= (unit === '%' ? 200 : 3840) ? undefined : '位置超出允许范围'
  return n >= 0 && n <= (unit === '%' ? 100 : 3840) ? undefined : '尺寸超出允许范围'
}

/** SDK 原生稀疏键的受限子集；不接收 HTML、script、attr、src 或外部 URL。 */
export const MotionOverrides = z
  .record(z.string(), z.union([z.string(), z.number()]))
  .superRefine((entries, ctx) => {
    for (const [key, value] of Object.entries(entries)) {
      const [id, group, property, ...extra] = key.split('.')
      const editable = motionEditable.find((entry) => entry.id === id)
      let problem: string | undefined
      if (!editable || extra.length) problem = '未知动态合成字段'
      else if (group === 'text' && property === undefined && editable.text) {
        if (typeof value !== 'string' || value.length > 1000) problem = '文本最多 1000 字符'
      } else if (
        group === 'style' &&
        (editable.styles as readonly string[]).includes(property ?? '')
      ) {
        problem = styleProblem(property!, value)
      } else if (group === 'timing' && (property === 'start' || property === 'end')) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 30)
          problem = '时间应在 0–30 秒之间'
      } else problem = '不支持的动态合成操作'
      if (problem) ctx.addIssue({ code: 'custom', path: [key], message: problem })
    }
  })
export type MotionOverrides = z.infer<typeof MotionOverrides>

const motionParams = z
  .object({
    template: z
      .enum(MOTION_TEMPLATES)
      .default('title')
      .meta({ title: '模板', labels: MOTION_TEMPLATE_LABELS }),
    title: z.string().max(1000).default('新的故事，即将开始').meta({ title: '标题' }),
    subtitle: z.string().max(1000).default('把创意带入画面').meta({ title: '副标题' }),
    accent: color.default('#d7f467').meta({ title: '强调色' }),
    background: color.default('#111827').meta({ title: '背景色' }),
    duration: z.number().min(1).max(30).default(6).meta({ title: '时长（秒）' }),
    aspectRatio: z.enum(['9:16', '16:9']).default('9:16').meta({ title: '画幅' }),
    resolution: z.enum(['720p', '1080p']).default('1080p').meta({ title: '分辨率' }),
    sourceIn: z.number().min(0).default(0).meta({ title: '素材入点（秒）' }),
    speed: z.number().min(0.25).max(4).default(1).meta({ title: '素材速度' }),
    audio: z
      .enum(['mute', 'source'])
      .default('mute')
      .meta({ title: '声音', labels: { mute: '静音', source: '保留视频原声' } }),
    overrides: MotionOverrides.default({}).meta({ title: '结构化编辑', widget: 'hidden' }),
  })
  .superRefine((params, ctx) => {
    const duration = Math.round(params.duration * MOTION_FPS) / MOTION_FPS
    for (const id of elementIds) {
      const start = Number(params.overrides[`${id}.timing.start`] ?? 0)
      const end = Number(params.overrides[`${id}.timing.end`] ?? duration)
      if (
        start >= end ||
        end > duration ||
        Math.round(start * MOTION_FPS) >= Math.round(end * MOTION_FPS)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['overrides', `${id}.timing.end`],
          message: '出现时间应早于结束时间，且不超过片段时长（至少一帧）',
        })
    }
  })

export const motionNode = defineNode({
  type: MOTION_TYPE,
  version: 1,
  title: '动态合成',
  description: '以已有素材制作片头、角色介绍与视频标题包装，本地渲染为视频',
  category: 'video',
  execution: 'job',
  inputs: [
    { id: 'image', label: '图片', type: 'image' },
    { id: 'video', label: '视频', type: 'video' },
  ],
  outputs: [{ id: 'video', label: '合成视频', type: 'video' }],
  params: motionParams,
})
export const MotionParams = motionNode.params
export type MotionParams = z.output<typeof MotionParams>

/** 编辑操作只描述编辑意图；UI/API 必须用本 schema 校验，不能直接执行任意 SDK patch。 */
export const MotionEditOperation = z
  .discriminatedUnion('op', [
    z
      .object({
        op: z.literal('text'),
        id: z.enum(['hf-title', 'hf-subtitle']),
        text: z.string().max(1000),
      })
      .strict(),
    z
      .object({
        op: z.literal('style'),
        id: z.enum(elementIds),
        property: z.enum([
          'color',
          'backgroundColor',
          'fontSize',
          'left',
          'top',
          'width',
          'height',
          'opacity',
          'borderRadius',
        ]),
        value: z.string(),
      })
      .strict(),
    z
      .object({
        op: z.literal('timing'),
        id: z.enum(elementIds),
        start: z.number().min(0).max(30),
        end: z.number().min(0).max(30),
      })
      .strict(),
  ])
  .superRefine((edit, ctx) => {
    if (edit.op === 'style') {
      const field = motionEditable.find((entry) => entry.id === edit.id)!
      const problem = !(field.styles as readonly string[]).includes(edit.property)
        ? '该元素不支持此样式'
        : styleProblem(edit.property, edit.value)
      if (problem) ctx.addIssue({ code: 'custom', path: ['value'], message: problem })
    }
    if (
      edit.op === 'timing' &&
      Math.round(edit.start * MOTION_FPS) >= Math.round(edit.end * MOTION_FPS)
    )
      ctx.addIssue({ code: 'custom', path: ['end'], message: '显示窗口至少需要一帧' })
  })
export type MotionEditOperation = z.infer<typeof MotionEditOperation>

export function applyMotionEdit(
  params: MotionParams,
  operation: MotionEditOperation,
): MotionParams {
  const edit = MotionEditOperation.parse(operation)
  const overrides = { ...params.overrides }
  if (edit.op === 'text') overrides[`${edit.id}.text`] = edit.text
  else if (edit.op === 'style') overrides[`${edit.id}.style.${edit.property}`] = edit.value
  else {
    overrides[`${edit.id}.timing.start`] = Math.round(edit.start * MOTION_FPS) / MOTION_FPS
    overrides[`${edit.id}.timing.end`] = Math.round(edit.end * MOTION_FPS) / MOTION_FPS
  }
  return motionNode.params.parse({ ...params, overrides })
}

export function motionSize(params: Pick<MotionParams, 'resolution' | 'aspectRatio'>) {
  const long = params.resolution === '720p' ? 1280 : 1920
  const short = params.resolution === '720p' ? 720 : 1080
  return params.aspectRatio === '9:16'
    ? { width: short, height: long }
    : { width: long, height: short }
}
export const motionDurationFrames = (params: Pick<MotionParams, 'duration'>) =>
  Math.round(params.duration * MOTION_FPS)

export interface MotionFiles {
  image?: string
  video?: string
  gsap?: string
  font?: string
  fontCss?: string
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  )
/** 只接受任务目录中的普通相对路径；URL、编码路径与目录越界均不属于此合同。 */
function localFile(path: string) {
  if (
    !/^[A-Za-z0-9_-][A-Za-z0-9_./-]{0,499}$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('动态合成依赖必须是包内本地相对路径')
  return path
}
const seconds = (value: number) => String(Math.round(value * MOTION_FPS) / MOTION_FPS)

/** 可信内置模板的纯函数投影；HTML 已应用 overrides，不应再应用一次 SDK 覆盖。 */
export function motionHtml(input: MotionParams, files: MotionFiles = {}): string {
  const params = motionNode.params.parse(input)
  for (const path of Object.values(files)) if (path !== undefined) localFile(path)
  const gsap = localFile(files.gsap ?? 'vendor/gsap.min.js')
  const { width, height } = motionSize(params)
  const duration = motionDurationFrames(params) / MOTION_FPS
  const portrait = params.aspectRatio === '9:16'
  const character = params.template === 'character'
  const video = params.template === 'video-title'
  const unit = width / (portrait ? 1080 : 1920)
  const px = (value: number) => `${Math.round(value * unit)}px`
  const styles: Record<MotionElementId, Record<string, string>> = {
    'hf-title': {
      color: '#ffffff',
      fontSize: px(portrait ? 104 : 112),
      left: '8%',
      top: character ? (portrait ? '65%' : '34%') : video ? '66%' : '37%',
      width: character && !portrait ? '47%' : '84%',
      opacity: '1',
    },
    'hf-subtitle': {
      color: '#d1d5db',
      fontSize: px(portrait ? 42 : 44),
      left: '8%',
      top: character ? (portrait ? '80%' : '64%') : video ? '84%' : '65%',
      width: character && !portrait ? '43%' : '84%',
      opacity: '1',
    },
    'hf-accent': {
      backgroundColor: params.accent,
      left: '8%',
      top: character ? (portrait ? '61%' : '26%') : video ? '62%' : '28%',
      width: '12%',
      height: px(10),
      opacity: '1',
      borderRadius: px(8),
    },
    'hf-media': {
      left: character ? (portrait ? '8%' : '58%') : '0%',
      top: character ? '6%' : '0%',
      width: character ? (portrait ? '84%' : '34%') : '100%',
      height: character ? (portrait ? '49%' : '88%') : '100%',
      opacity: '1',
      borderRadius: character ? px(36) : '0px',
    },
  }
  const text: Record<string, string> = { 'hf-title': params.title, 'hf-subtitle': params.subtitle }
  for (const [key, value] of Object.entries(params.overrides)) {
    const [id, group, property] = key.split('.')
    if (group === 'text') text[id!] = String(value)
    if (group === 'style') styles[id as MotionElementId][property!] = String(value)
  }
  const timing = (id: MotionElementId) => ({
    start: Number(seconds(Number(params.overrides[`${id}.timing.start`] ?? 0))),
    end: Number(seconds(Number(params.overrides[`${id}.timing.end`] ?? duration))),
  })
  const attrs = (id: MotionElementId, track: number) => {
    const t = timing(id)
    const style = Object.entries(styles[id])
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}:${value}`)
      .join(';')
    return `id="${id}" data-hf-id="${id}" class="clip" data-start="${seconds(t.start)}" data-end="${seconds(t.end)}" data-duration="${seconds(t.end - t.start)}" data-track-index="${track}" style="${escapeHtml(style)}"`
  }
  const media =
    video && files.video
      ? `<video ${attrs('hf-media', 0)} src="${escapeHtml(files.video)}" preload="auto" playsinline data-playback-start="${params.sourceIn}" data-playback-rate="${params.speed}" data-volume="${params.audio === 'source' ? 1 : 0}"${params.audio === 'mute' ? ' muted' : ''}></video>`
      : character && files.image
        ? `<img ${attrs('hf-media', 0)} src="${escapeHtml(files.image)}" alt="" />`
        : `<div ${attrs('hf-media', 0)}></div>`
  const animations = motionEditable
    .map(({ id }) => {
      const t = timing(id)
      const enter = Math.min(0.6, (t.end - t.start) / 3)
      const exit = Math.min(0.35, (t.end - t.start) / 3)
      const alpha = Number(styles[id].opacity)
      return `tl.fromTo('#${id}', {opacity:0,${id === 'hf-accent' ? 'scaleX:0' : 'y:28'}}, {opacity:${alpha},${id === 'hf-accent' ? 'scaleX:1' : 'y:0'},duration:${enter},ease:'power2.out',immediateRender:false}, ${t.start});\ntl.to('#${id}', {opacity:0,duration:${exit},ease:'power1.in'}, ${t.end - exit});`
    })
    .join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${files.fontCss ? `<link rel="stylesheet" href="${files.fontCss}">` : ''}
<style>${files.font ? `@font-face{font-family:PleinMotion;src:url('${files.font}')}` : ''}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${params.background}}
#hf-root{position:relative;overflow:hidden;width:${width}px;height:${height}px;background:${params.background};font-family:'Noto Sans SC',PleinMotion,'Arial',sans-serif}
.clip{position:absolute}#hf-title,#hf-subtitle{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.15;font-weight:700}#hf-subtitle{font-weight:400;line-height:1.4}#hf-media{object-fit:cover;background:${character ? params.accent : params.background}}#hf-accent{transform-origin:left center}${video ? '#hf-title,#hf-subtitle{text-shadow:0 2px 18px #000000}' : ''}
</style></head><body><main id="hf-root" data-hf-id="hf-root" data-hf-root data-composition-id="plein-motion" data-start="0" data-duration="${seconds(duration)}" data-width="${width}" data-height="${height}">
${media}
<div ${attrs('hf-accent', 1)}></div>
<h1 ${attrs('hf-title', 2)}>${escapeHtml(text['hf-title']!)}</h1>
<p ${attrs('hf-subtitle', 3)}>${escapeHtml(text['hf-subtitle']!)}</p>
</main><script src="${gsap}"></script><script>
const tl=gsap.timeline({paused:true});
${animations}
tl.to({}, {duration:${duration}}, 0);
window.__timelines=window.__timelines||{};window.__timelines['plein-motion']=tl;
</script></body></html>`
}

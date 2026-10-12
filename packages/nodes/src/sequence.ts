import {
  type AssetRef,
  type ComposeAudio,
  type ComposeSpec,
  defineNode,
  type PortValue,
  type SubtitleStyle,
  type TranscriptSegment,
} from '@plein/plugin-sdk'
import { z } from 'zod'

/** 序列里的一段镜头：按 source（上游元素 id）对应连进来的视频 */
export const SequenceClip = z.object({
  source: z.string(),
  /** 入点、出点（秒）；出点不填到素材结尾 */
  in: z.number().min(0).default(0),
  out: z.number().min(0).optional(),
  /** 这段的对白（对白端口上游元素 id）；空字符串表示不配，不填按顺序自动对应 */
  dialogue: z.string().optional(),
  /** 这段的音效，规则同对白 */
  sfx: z.string().optional(),
  /** 字幕；不填用对白的台词 */
  subtitle: z.string().optional(),
})
export type SequenceClip = z.infer<typeof SequenceClip>

export const SEQUENCE_TYPE = 'plein/sequence'

const SUBTITLE_STYLES = ['常规', '醒目', '底框'] as const
export const TRANSITIONS = ['无', '淡入淡出', '叠化'] as const
const STYLE_IDS: Record<(typeof SUBTITLE_STYLES)[number], SubtitleStyle> = {
  常规: 'standard',
  醒目: 'bold',
  底框: 'boxed',
}

const volume = (title: string, value: number) =>
  z.number().min(0).max(2).default(value).meta({ title })

/** 序列：把镜头视频按顺序拼成成片，混合对白、配乐、音效，烧录字幕，导出 MP4 */
export const sequenceNode = defineNode({
  type: SEQUENCE_TYPE,
  version: 1,
  title: '序列',
  description: '把镜头视频按顺序拼接，配上对白、配乐、音效和字幕，导出 MP4',
  category: 'video',
  execution: 'job',
  inputs: [
    { id: 'clips', label: '镜头', type: 'video', multiple: true, required: true },
    { id: 'dialogue', label: '对白', type: 'audio', multiple: true },
    { id: 'music', label: '配乐', type: 'audio' },
    { id: 'sfx', label: '音效', type: 'audio', multiple: true },
  ],
  outputs: [{ id: 'video', label: '成片', type: 'video' }],
  params: z.object({
    clips: z.array(SequenceClip).default([]).meta({ title: '镜头', widget: 'hidden' }),
    aspectRatio: z.enum(['9:16', '16:9']).default('9:16').meta({ title: '画幅' }),
    resolution: z.enum(['1080p', '720p']).default('1080p').meta({ title: '分辨率' }),
    subtitles: z.boolean().default(true).meta({ title: '字幕' }),
    subtitleStyle: z.enum(SUBTITLE_STYLES).default('常规').meta({ title: '字幕样式' }),
    clipVolume: volume('镜头原声音量', 1),
    dialogueVolume: volume('对白音量', 1),
    musicVolume: volume('配乐音量', 0.35),
    sfxVolume: volume('音效音量', 0.8),
    transition: z.enum(TRANSITIONS).default('无').meta({ title: '转场' }),
    transitionDuration: z.number().min(0.2).max(2).default(0.5).meta({ title: '转场时长（秒）' }),
    asrTiming: z.boolean().default(false).meta({
      title: '按语音识别对齐字幕',
      description: '用已启用平台的语音识别校准每句字幕的时间',
    }),
  }),
})

export type SequenceParams = z.output<typeof sequenceNode.params>

type MediaValue = Extract<PortValue, { assetId: string }>

const media = (values: PortValue[] | undefined) =>
  (values ?? []).filter((v): v is MediaValue => 'assetId' in v)

const asset = (v: MediaValue): AssetRef => ({ assetId: v.assetId, kind: v.kind, mime: v.mime })

export interface ArrangedClip {
  /** 上游元素 id；没有时只能按顺序对应 */
  source?: string
  clip: MediaValue
  in: number
  out?: number
  dialogue?: MediaValue
  sfx?: MediaValue
  subtitle?: string
}

/**
 * 按参数排好镜头：参数里记着的镜头按参数顺序在前，新连进来的按画布位置排在后面，
 * 已断开的设置丢掉。对白、音效没指定时按顺序对应第 n 段。
 */
export function arrangeSequence(
  params: Pick<SequenceParams, 'clips'>,
  inputs: Record<string, PortValue[]>,
): ArrangedClip[] {
  const clips = media(inputs.clips)
  const dialogue = media(inputs.dialogue)
  const sfx = media(inputs.sfx)
  const settings = new Map(params.clips.map((c) => [c.source, c]))
  const order = new Map(params.clips.map((c, i) => [c.source, i]))
  const sorted = clips
    .map((clip, i) => ({ clip, i }))
    .sort((a, b) => {
      const oa = a.clip.source !== undefined ? order.get(a.clip.source) : undefined
      const ob = b.clip.source !== undefined ? order.get(b.clip.source) : undefined
      if (oa !== undefined && ob !== undefined) return oa - ob
      if (oa !== undefined) return -1
      if (ob !== undefined) return 1
      return a.i - b.i
    })
  const pick = (list: MediaValue[], choice: string | undefined, index: number) => {
    if (choice === '') return undefined
    if (choice !== undefined) return list.find((v) => v.source === choice)
    return list[index]
  }
  return sorted.map(({ clip }, index) => {
    const s = clip.source !== undefined ? settings.get(clip.source) : undefined
    return {
      source: clip.source,
      clip,
      in: s?.in ?? 0,
      out: s?.out,
      dialogue: pick(dialogue, s?.dialogue, index),
      sfx: pick(sfx, s?.sfx, index),
      subtitle: s?.subtitle,
    }
  })
}

const SIZES = {
  '1080p': { '9:16': [1080, 1920], '16:9': [1920, 1080] },
  '720p': { '9:16': [720, 1280], '16:9': [1280, 720] },
} as const

/** 每段实际时长：出点不超过素材结尾，入点之前的部分去掉 */
export function clipLength(c: Pick<ArrangedClip, 'in' | 'out'>, duration: number) {
  return Math.max(0, Math.min(c.out ?? duration, duration) - c.in)
}

export interface Cue {
  start: number
  end: number
  text: string
}

/** 按句末标点切句，标点留在句子里 */
function splitSentences(text: string) {
  return (text.match(/[^。！？!?；;\n]+[。！？!?；;]*/g) ?? []).map((s) => s.trim()).filter(Boolean)
}

/**
 * 一条对白的字幕（时间相对对白开头）：
 * - 有识别结果时按识别出的时间：台词句数和识别段数一致就逐句对上，否则整段台词铺满说话的时间；
 *   没有台词时直接用识别出的文字；
 * - 没有识别结果时整段台词铺满 fallback 秒。
 */
export function dialogueCues(
  text: string,
  segments: TranscriptSegment[] | undefined,
  fallback: number,
): Cue[] {
  const segs = (segments ?? []).filter((s) => s.end > s.start)
  if (!segs.length) return text ? [{ start: 0, end: fallback, text }] : []
  if (!text) return segs.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
  const sentences = splitSentences(text)
  if (sentences.length === segs.length)
    return segs.map((s, i) => ({ start: s.start, end: s.end, text: sentences[i]! }))
  return [{ start: segs[0]!.start, end: segs.at(-1)!.end, text }]
}

export interface TimelineClip {
  start: number
  length: number
  /** 对白在成片里的起点和播放时长 */
  dialogue?: { start: number; duration: number }
  cues: Cue[]
}

export interface Timeline {
  clips: TimelineClip[]
  total: number
  /** 实际使用的转场时长（叠化时受最短镜头限制），0 表示硬切 */
  transition: { type: 'fade' | 'dissolve'; duration: number } | null
}

/**
 * 排时间线：叠化时相邻镜头重叠转场时长，淡入淡出（经黑场）不改变时长。
 * 对白从所属镜头开头播放，可以延续到下一段有对白的镜头开始；
 * 字幕跟着对白（有识别结果时按识别时间），没有对白时铺满这段镜头。
 */
export function sequenceTimeline(
  params: SequenceParams,
  arranged: ArrangedClip[],
  durations: { clips: number[]; dialogue: Array<number | undefined> },
  transcripts: Array<TranscriptSegment[] | undefined> = [],
): Timeline {
  const lengths = arranged.map((c, i) => clipLength(c, durations.clips[i] ?? 0))
  const playing = lengths.filter((l) => l > 0)
  let transition: Timeline['transition'] = null
  if (params.transition !== '无' && playing.length > 1) {
    const type = params.transition === '叠化' ? 'dissolve' : 'fade'
    // 叠化的重叠部分不能超过最短镜头的一半
    const limit = type === 'dissolve' ? Math.min(...playing) / 2 : Math.min(...playing)
    const duration = Math.min(params.transitionDuration, limit)
    if (duration > 0.04) transition = { type, duration }
  }
  const overlap = transition?.type === 'dissolve' ? transition.duration : 0
  const starts: number[] = []
  let t = 0
  let first = true
  for (const len of lengths) {
    if (len > 0 && !first) t -= overlap
    starts.push(t)
    if (len > 0) {
      t += len
      first = false
    }
  }
  const total = Math.max(0, t)
  const clips = arranged.map((c, i): TimelineClip => {
    const start = starts[i]!
    const length = lengths[i]!
    if (length === 0) return { start, length, cues: [] }
    let until = total
    for (let j = i + 1; j < arranged.length; j++) {
      if (arranged[j]!.dialogue && lengths[j]! > 0) {
        until = starts[j]!
        break
      }
    }
    const room = until - start
    const dialogue = c.dialogue
      ? { start, duration: Math.min(durations.dialogue[i] ?? room, room) }
      : undefined
    let cues: Cue[] = []
    if (params.subtitles) {
      if (c.subtitle?.trim())
        cues = [{ start: 0, end: dialogue?.duration ?? length, text: c.subtitle.trim() }]
      else if (dialogue)
        cues = dialogueCues((c.dialogue?.caption ?? '').trim(), transcripts[i], dialogue.duration)
      cues = cues
        .map((q) => ({
          start: start + q.start,
          // 太短看不清，至少停留 1 秒（不超过镜头）
          end: Math.min(start + Math.max(q.end, q.start + Math.min(1, length)), total),
          text: q.text,
        }))
        .filter((q) => q.end > q.start && q.text)
    }
    return { start, length, dialogue, cues }
  })
  return { clips, total, transition }
}

/** 生成合成参数：画面、各段声音、配乐（循环铺满，结尾淡出）、字幕和转场 */
export function sequenceSpec(
  params: SequenceParams,
  arranged: ArrangedClip[],
  durations: { clips: number[]; dialogue: Array<number | undefined> },
  music: PortValue[] | undefined,
  name?: string,
  transcripts?: Array<TranscriptSegment[] | undefined>,
): ComposeSpec {
  const [width, height] = SIZES[params.resolution][params.aspectRatio]
  const tl = sequenceTimeline(params, arranged, durations, transcripts)
  const audio: ComposeAudio[] = []
  arranged.forEach((c, i) => {
    const t = tl.clips[i]!
    if (t.length === 0) return
    if (c.dialogue && t.dialogue)
      audio.push({
        asset: asset(c.dialogue),
        start: t.dialogue.start,
        duration: t.dialogue.duration,
        volume: params.dialogueVolume,
      })
    if (c.sfx)
      audio.push({
        asset: asset(c.sfx),
        start: t.start,
        duration: t.length,
        volume: params.sfxVolume,
      })
  })
  for (const m of media(music)) {
    audio.push({ asset: asset(m), start: 0, volume: params.musicVolume, loop: true, fadeOut: 2 })
  }
  const cues = tl.clips.flatMap((t) => t.cues)
  return {
    width,
    height,
    fps: 30,
    clips: arranged.flatMap((c, i) => {
      const len = tl.clips[i]!.length
      return len > 0
        ? [{ asset: asset(c.clip), in: c.in, out: c.in + len, volume: params.clipVolume }]
        : []
    }),
    audio,
    subtitles: cues.length ? { cues, style: STYLE_IDS[params.subtitleStyle] } : undefined,
    transition: tl.transition ?? undefined,
    name,
  }
}

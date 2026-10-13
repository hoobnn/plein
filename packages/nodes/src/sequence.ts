import {
  type AssetRef,
  type ComposeAudio,
  type ComposeSpec,
  type ComposeTransition,
  defineNode,
  overlapping,
  type PortValue,
  type SubtitleStyle,
  type TranscriptSegment,
} from '@plein/plugin-sdk'
import { z } from 'zod'

export const TRANSITIONS = ['无', '淡入淡出', '叠化', '划像', '推移', '闪白'] as const
export type TransitionName = (typeof TRANSITIONS)[number]
const TRANSITION_TYPES: Record<Exclude<TransitionName, '无'>, ComposeTransition['type']> = {
  淡入淡出: 'fade',
  叠化: 'dissolve',
  划像: 'wipe',
  推移: 'slide',
  闪白: 'flash',
}
/** 对白时配乐压到的音量（约 -10 dB），前后各留一点起落 */
export const DUCK_LEVEL = 0.32
const DUCK_ATTACK = 0.15
const DUCK_RELEASE = 0.4
/** 配乐结尾淡出秒数 */
export const MUSIC_FADE = 2

/** 序列里的一段镜头：按 source（上游元素 id）对应连进来的视频 */
export const SequenceClip = z.object({
  source: z.string(),
  /** 入点、出点（秒）；出点不填到素材结尾 */
  in: z.number().min(0).default(0),
  out: z.number().min(0).optional(),
  /** 这段的对白（对白端口上游元素 id）；空字符串表示不配，不填按顺序自动对应 */
  dialogue: z.string().optional(),
  /** 同一段镜头里接在对白后面依次播放的其他台词（对白端口上游元素 id，按顺序） */
  more: z.array(z.string()).optional(),
  /** 这段的音效，规则同对白 */
  sfx: z.string().optional(),
  /** 字幕；不填用对白的台词 */
  subtitle: z.string().optional(),
  /** 从上一段切到这段的转场和时长；不填跟随全局 */
  transition: z.enum(TRANSITIONS).optional(),
  transitionDuration: z.number().min(0.2).max(2).optional(),
  /** 这段原声的音量（再乘全局原声音量），默认 1 */
  volume: z.number().min(0).max(2).optional(),
  /** 播放速度，默认 1 */
  speed: z.number().min(0.25).max(4).optional(),
  /** 台词在镜头开始后多久开始说（秒），默认 0 */
  lineDelay: z.number().min(0).max(10).optional(),
})
export type SequenceClip = z.infer<typeof SequenceClip>

export const SEQUENCE_TYPE = 'plein/sequence'

const SUBTITLE_STYLES = ['常规', '醒目', '底框'] as const
export const SUBTITLE_STYLE_IDS: Record<(typeof SUBTITLE_STYLES)[number], SubtitleStyle> = {
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
    duck: z.boolean().default(true).meta({
      title: '对白时压低配乐',
      description: '有台词的地方配乐自动降低约 10 dB，说完再回来',
    }),
    loudnorm: z.boolean().default(true).meta({
      title: '响度标准化',
      description: '成片响度统一到 -14 LUFS（短视频平台的通行响度）',
    }),
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
  /** 接在 dialogue 后面依次播放的台词 */
  more: MediaValue[]
  sfx?: MediaValue
  subtitle?: string
  /** 播放速度 */
  speed: number
  /** 原声音量倍数 */
  volume: number
  /** 台词延后（秒） */
  lineDelay: number
  /** 进入这段的转场（不填跟随全局） */
  transition?: TransitionName
  transitionDuration?: number
}

/**
 * 按参数排好镜头：参数里记着的镜头按参数顺序在前，新连进来的按画布位置排在后面，
 * 已断开的设置丢掉。对白、音效没指定时按顺序对应第 n 段（别的段已经指定了的除外）。
 */
export function arrangeSequence(
  params: Pick<SequenceParams, 'clips'>,
  inputs: Record<string, PortValue[]>,
): ArrangedClip[] {
  const clips = media(inputs.clips)
  // 写进某段 more 的台词只在那一段播，不参与按顺序自动对应
  const extra = new Set(params.clips.flatMap((c) => c.more ?? []))
  const allDialogue = media(inputs.dialogue)
  const dialogue = allDialogue.filter((v) => v.source === undefined || !extra.has(v.source))
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
  // 已经被某段明确指定的对白、音效，不再按顺序自动对应给别的段（调换顺序后不会一条台词播两遍）
  const claimed = new Set(params.clips.flatMap((c) => [c.dialogue, c.sfx]).filter(Boolean))
  const pick = (list: MediaValue[], choice: string | undefined, index: number) => {
    if (choice === '') return undefined
    if (choice !== undefined) return list.find((v) => v.source === choice)
    const auto = list[index]
    return auto?.source !== undefined && claimed.has(auto.source) ? undefined : auto
  }
  return sorted.map(({ clip }, index) => {
    const s = clip.source !== undefined ? settings.get(clip.source) : undefined
    return {
      source: clip.source,
      clip,
      in: s?.in ?? 0,
      out: s?.out,
      dialogue: pick(dialogue, s?.dialogue, index),
      more: (s?.more ?? []).flatMap((id) => allDialogue.filter((v) => v.source === id)),
      sfx: pick(sfx, s?.sfx, index),
      subtitle: s?.subtitle,
      speed: s?.speed ?? 1,
      volume: s?.volume ?? 1,
      lineDelay: s?.lineDelay ?? 0,
      transition: s?.transition,
      transitionDuration: s?.transitionDuration,
    }
  })
}

const SIZES = {
  '1080p': { '9:16': [1080, 1920], '16:9': [1920, 1080] },
  '720p': { '9:16': [720, 1280], '16:9': [1280, 720] },
} as const

/** 成片的像素尺寸 */
export function sequenceSize(params: Pick<SequenceParams, 'resolution' | 'aspectRatio'>) {
  const [width, height] = SIZES[params.resolution][params.aspectRatio]
  return { width, height }
}

/** 每段在成片里的时长：出点不超过素材结尾，入点之前的部分去掉，再按速度换算 */
export function clipLength(
  c: Pick<ArrangedClip, 'in' | 'out'> & { speed?: number },
  duration: number,
) {
  return Math.max(0, Math.min(c.out ?? duration, duration) - c.in) / (c.speed ?? 1)
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
  /** 从上一段切进来的转场（第一段、硬切时为空）；重叠转场时这段比上一段结尾早 duration 开始 */
  transition?: ComposeTransition
  /** 各句对白（dialogue 和 more 依次）在成片里的起点和播放时长；放不下的句子不在里面 */
  lines: Array<{ start: number; duration: number }>
  cues: Cue[]
}

/** 同一段镜头里相邻两句台词之间的停顿（秒） */
export const LINE_GAP = 0.2

/** 这段镜头依次播放的全部台词 */
export const clipLines = (c: Pick<ArrangedClip, 'dialogue' | 'more'>) =>
  c.dialogue ? [c.dialogue, ...c.more] : [...c.more]

/** 各段的台词时长：dialogue 是每段第一句，more 是其余各句（与 ArrangedClip.more 对应） */
export interface SequenceDurations {
  clips: number[]
  dialogue: Array<number | undefined>
  more?: Array<Array<number | undefined>>
}

export interface Timeline {
  clips: TimelineClip[]
  total: number
}

/**
 * 排时间线：每段可以单独指定进入它的转场，不指定跟随全局。
 * 叠化、划像、推移、闪白让相邻镜头重叠转场时长，经黑场淡入淡出不改变时长；
 * 转场时长不超过相邻两段里较短那段（重叠转场是一半）。
 * 对白从所属镜头开头（加上台词延后）播放，可以延续到下一段有对白的镜头开始；
 * 字幕跟着对白（有识别结果时按识别时间），没有对白时铺满这段镜头。
 */
export function sequenceTimeline(
  params: SequenceParams,
  arranged: ArrangedClip[],
  durations: SequenceDurations,
  transcripts: Array<TranscriptSegment[] | undefined> = [],
): Timeline {
  const lengths = arranged.map((c, i) => clipLength(c, durations.clips[i] ?? 0))
  const transitions: Array<ComposeTransition | undefined> = []
  let prev = -1
  arranged.forEach((c, i) => {
    const len = lengths[i]!
    if (len <= 0) return
    if (prev >= 0) {
      const name = c.transition ?? params.transition
      if (name !== '无') {
        const type = TRANSITION_TYPES[name]
        const room = Math.min(lengths[prev]!, len)
        const duration = Math.min(
          c.transitionDuration ?? params.transitionDuration,
          type === 'fade' ? room : room / 2,
        )
        if (duration > 0.04) transitions[i] = { type, duration: Number(duration.toFixed(3)) }
      }
    }
    prev = i
  })
  const starts: number[] = []
  let t = 0
  arranged.forEach((_, i) => {
    const tr = transitions[i]
    if (overlapping(tr)) t -= tr!.duration
    starts.push(t)
    t += lengths[i]!
  })
  const total = Math.max(0, t)
  const clips = arranged.map((c, i): TimelineClip => {
    const start = starts[i]!
    const length = lengths[i]!
    const transition = transitions[i]
    if (length === 0) return { start, length, lines: [], cues: [] }
    let until = total
    for (let j = i + 1; j < arranged.length; j++) {
      if (clipLines(arranged[j]!).length && lengths[j]! > 0) {
        until = starts[j]!
        break
      }
    }
    const room = until - start
    // 台词从镜头开头（加上延后）依次播放，可以延续到下一段有对白的镜头开始；放不下的句子丢掉
    const own = clipLines(c)
    const lines: TimelineClip['lines'] = []
    let at = Math.min(c.lineDelay, room)
    own.forEach((_, k) => {
      if (at >= room - 0.04) return
      const d =
        k === 0 && c.dialogue
          ? durations.dialogue[i]
          : durations.more?.[i]?.[c.dialogue ? k - 1 : k]
      const duration = Math.min(d ?? room - at, room - at)
      lines.push({ start: start + at, duration })
      at += duration + LINE_GAP
    })
    let cues: Cue[] = []
    if (params.subtitles) {
      const span = lines.length ? lines.at(-1)!.start + lines.at(-1)!.duration - start : length
      if (c.subtitle?.trim()) cues = [{ start: 0, end: span, text: c.subtitle.trim() }]
      else
        cues = lines.flatMap((l, k) => {
          const offset = l.start - start
          // 识别结果只对第一句（dialogue）做
          const segs = k === 0 && c.dialogue ? transcripts[i] : undefined
          return dialogueCues((own[k]!.caption ?? '').trim(), segs, l.duration).map((q) => ({
            start: offset + q.start,
            end: offset + q.end,
            text: q.text,
          }))
        })
      cues = cues
        .map((q) => ({
          start: start + q.start,
          // 太短看不清，至少停留 1 秒（不超过镜头）
          end: Math.min(start + Math.max(q.end, q.start + Math.min(1, length)), total),
          text: q.text,
        }))
        .filter((q) => q.end > q.start && q.text)
      // 至少停留 1 秒会让前一句盖到后一句上：截到后一句开始
      for (let k = 0; k + 1 < cues.length; k++)
        cues[k]!.end = Math.min(cues[k]!.end, Math.max(cues[k]!.start + 0.04, cues[k + 1]!.start))
    }
    return { start, length, lines, cues, transition }
  })
  return { clips, total }
}

/**
 * 对白时压低配乐的音量包络（成片时间，倍数）：每句台词前 0.15 秒压下去，说完 0.4 秒回来；
 * 两句挨得近时中间不回升。没有台词时为空。
 */
export function duckEnvelope(timeline: Timeline): Array<[number, number]> {
  const spans = timeline.clips
    .flatMap((c) => c.lines.map((l) => [l.start, l.start + l.duration] as [number, number]))
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  const merged: Array<[number, number]> = []
  for (const [a, b] of spans) {
    const last = merged.at(-1)
    if (last && a - last[1] < DUCK_ATTACK + DUCK_RELEASE) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  // 开头就有台词时一开始就是压低的（包络在第一个点之前取第一个点的值）
  return merged.flatMap(([a, b]): Array<[number, number]> => [
    ...(a >= DUCK_ATTACK ? [[a - DUCK_ATTACK, 1] as [number, number]] : []),
    [a, DUCK_LEVEL],
    [b, DUCK_LEVEL],
    [b + DUCK_RELEASE, 1],
  ])
}

/** 生成合成参数：画面、各段声音、配乐（循环铺满，结尾淡出）、字幕和转场 */
export function sequenceSpec(
  params: SequenceParams,
  arranged: ArrangedClip[],
  durations: SequenceDurations,
  music: PortValue[] | undefined,
  name?: string,
  transcripts?: Array<TranscriptSegment[] | undefined>,
): ComposeSpec {
  const { width, height } = sequenceSize(params)
  const tl = sequenceTimeline(params, arranged, durations, transcripts)
  const audio: ComposeAudio[] = []
  arranged.forEach((c, i) => {
    const t = tl.clips[i]!
    if (t.length === 0) return
    const own = clipLines(c)
    t.lines.forEach((l, k) =>
      audio.push({
        asset: asset(own[k]!),
        start: l.start,
        duration: l.duration,
        volume: params.dialogueVolume,
      }),
    )
    if (c.sfx)
      audio.push({
        asset: asset(c.sfx),
        start: t.start,
        duration: t.length,
        volume: params.sfxVolume,
      })
  })
  const duck = params.duck ? duckEnvelope(tl) : []
  for (const m of media(music)) {
    audio.push({
      asset: asset(m),
      start: 0,
      volume: params.musicVolume,
      loop: true,
      fadeOut: MUSIC_FADE,
      envelope: duck.length ? duck : undefined,
    })
  }
  const cues = tl.clips.flatMap((t) => t.cues)
  return {
    width,
    height,
    fps: 30,
    clips: arranged.flatMap((c, i) => {
      const { length, transition } = tl.clips[i]!
      if (length <= 0) return []
      return [
        {
          asset: asset(c.clip),
          in: c.in,
          out: c.in + length * c.speed,
          volume: params.clipVolume * c.volume,
          ...(c.speed !== 1 && { speed: c.speed }),
          ...(transition && { transition }),
        },
      ]
    }),
    audio,
    subtitles: cues.length ? { cues, style: SUBTITLE_STYLE_IDS[params.subtitleStyle] } : undefined,
    loudnorm: params.loudnorm || undefined,
    name,
  }
}

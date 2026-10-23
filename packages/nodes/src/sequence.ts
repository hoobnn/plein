import {
  type AssetRef,
  type ComposeAudio,
  type ComposeCue,
  type ComposeOverlay,
  type ComposeSpec,
  type ComposeTransition,
  type CompositionSource,
  defineNode,
  overlapping,
  type PortValue,
  type SubtitleStyle,
  SUBTITLE_ORIGINS,
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

const resultIdentity = z.object({
  canvasId: z.string().min(1),
  nodeId: z.string().min(1),
  port: z.string().min(1),
  resultId: z.string().min(1),
  runId: z.string().min(1),
})

/** 序列里的一段镜头：按 source（上游元素 id）对应连进来的视频 */
export const SequenceClip = z.object({
  source: z.string(),
  clipInstanceId: z.string().min(1).optional(),
  port: z.string().min(1).optional(),
  edgeId: z.string().min(1).optional(),
  segment: z
    .object({
      version: z.literal(1),
      segmentId: z.string().min(1),
      asset: z.object({
        assetId: z.string().regex(/^[0-9a-f]{64}$/),
        kind: z.literal('video'),
        mime: z.string().optional(),
      }),
      duration: z.number().finite().positive(),
      origin: resultIdentity.optional(),
      selection: resultIdentity.optional(),
    })
    .optional(),
  narrative: z
    .object({
      canvasId: z.string().min(1),
      boardId: z.string().min(1),
      shotId: z.string().min(1),
      historical: z.boolean().optional(),
    })
    .optional(),
  sound: z.enum(['legacy', 'native', 'voice', 'mix']).optional(),
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
  lineGap: z.number().min(0).max(10).optional(),
})
export type SequenceClip = z.infer<typeof SequenceClip>

/** source 为 overlays 输入的上游元素；clip 为背景镜头 source，start 是镜头内或成片绝对秒。 */
export const SequenceOverlay = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  clip: z.string().min(1).optional(),
  start: z.number().finite().min(0).default(0),
  in: z.number().finite().min(0).default(0),
  duration: z.number().finite().positive(),
  speed: z.number().finite().min(0.25).max(4).default(1),
  x: z.number().finite().min(0).max(1).default(0),
  y: z.number().finite().min(0).max(1).default(0),
  width: z.number().finite().positive().max(1).default(1),
  height: z.number().finite().positive().max(1).default(1),
  opacity: z.number().finite().min(0).max(1).default(1),
  hidden: z.boolean().default(false),
})
export type SequenceOverlay = z.output<typeof SequenceOverlay>

export const SEQUENCE_TYPE = 'plein/sequence'

const SUBTITLE_STYLES = ['常规', '醒目', '底框'] as const
export const SUBTITLE_STYLE_IDS: Record<(typeof SUBTITLE_STYLES)[number], SubtitleStyle> = {
  常规: 'standard',
  醒目: 'bold',
  底框: 'boxed',
}

const volume = (title: string, value: number) =>
  z.number().min(0).max(2).default(value).meta({ title })

/** 字幕使用镜头内的相对秒数，移动镜头时随镜头走；hidden 保留文本和时间供恢复。 */
export const SequenceSubtitleCue = z.object({
  id: z.string(),
  source: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string(),
  origin: z.enum(SUBTITLE_ORIGINS).default('legacy'),
  hidden: z.boolean().default(false),
})
export const SequenceSubtitleTrack = z.object({
  inputKey: z.string(),
  cues: z.array(SequenceSubtitleCue),
  /** Migrated v1 key; compare against the real old inputs until an explicit subtitle edit/rebuild. */
  keyVersion: z.literal(1).optional(),
  legacySources: z.record(z.string(), z.string()).optional(),
  /** Unresolved v1 evidence is retained verbatim and never rendered or guessed onto a new row. */
  unmappedCues: z.array(z.object({ cue: z.unknown(), reason: z.string() })).optional(),
  legacyTrack: z.unknown().optional(),
})
export type SequenceSubtitleTrack = z.infer<typeof SequenceSubtitleTrack>

/** 序列：把镜头视频按顺序拼成成片，混合对白、配乐、音效，烧录字幕，导出 MP4 */
export const sequenceNode = defineNode({
  type: SEQUENCE_TYPE,
  version: 2,
  title: '序列',
  description: '把镜头视频按顺序拼接，配上对白、配乐、音效和字幕，导出 MP4',
  category: 'video',
  execution: 'job',
  inputs: [
    // 固定素材的镜头不接上游也能跑，镜头口不能设为必填
    { id: 'clips', label: '镜头', type: 'video', multiple: true },
    { id: 'overlays', label: '叠加', type: 'video', multiple: true },
    { id: 'dialogue', label: '对白', type: 'audio', multiple: true },
    { id: 'music', label: '配乐', type: 'audio' },
    { id: 'sfx', label: '音效', type: 'audio', multiple: true },
  ],
  outputs: [{ id: 'video', label: '成片', type: 'video' }],
  params: z
    .object({
      instanceVersion: z.literal(2).optional().meta({ widget: 'hidden' }),
      legacySourceSettings: z.array(z.unknown()).optional().meta({ widget: 'hidden' }),
      clips: z.array(SequenceClip).default([]).meta({ title: '镜头', widget: 'hidden' }),
      overlays: z
        .array(SequenceOverlay)
        .max(200)
        .default([])
        .meta({ title: '叠加轨', widget: 'hidden' }),
      aspectRatio: z.enum(['9:16', '16:9']).default('9:16').meta({ title: '画幅' }),
      resolution: z.enum(['1080p', '720p']).default('1080p').meta({ title: '分辨率' }),
      subtitles: z.boolean().default(true).meta({ title: '字幕' }),
      subtitleStyle: z.enum(SUBTITLE_STYLES).default('常规').meta({ title: '字幕样式' }),
      subtitleRender: z
        .enum(['static', 'animated', 'none'])
        .default('static')
        .meta({ title: '字幕渲染' }),
      subtitleAnimation: z.enum(['fade', 'pop']).default('pop').meta({ title: '字幕动画' }),
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
      model: z.string().default('').meta({ title: '语音识别模型', widget: 'hidden' }),
      subtitleTrack: SequenceSubtitleTrack.optional().meta({ title: '字幕轨', widget: 'hidden' }),
    })
    .superRefine((p, ctx) => {
      if (p.instanceVersion !== 2) return
      const seen = new Set<string>(),
        segments = new Map<string, string>()
      p.clips.forEach((c, i) => {
        if (!c.clipInstanceId || !c.source || !c.port || !c.sound || seen.has(c.clipInstanceId))
          ctx.addIssue({
            code: 'custom',
            path: ['clips', i],
            message: '剪辑实例身份、端口和声音路线必须明确且唯一',
          })
        if (c.clipInstanceId) seen.add(c.clipInstanceId)
        if (c.segment) {
          if (c.sound === 'legacy')
            ctx.addIssue({
              code: 'custom',
              path: ['clips', i, 'sound'],
              message: '固定素材必须明确选择原生声、配音或混合',
            })
          const value = JSON.stringify(c.segment)
          const old = segments.get(c.segment.segmentId)
          if (old && old !== value)
            ctx.addIssue({
              code: 'custom',
              path: ['clips', i, 'segment'],
              message: '同一固定段身份不能对应不同文件或出处',
            })
          segments.set(c.segment.segmentId, value)
        }
      })
    }),
  // Frozen v1 jobs keep their real v1 source-key behavior; document migration has edge identities.
  migrate: (params) => params,
})

export type SequenceParams = z.output<typeof sequenceNode.params>

type MediaValue = Extract<PortValue, { assetId: string }>

const media = (values: PortValue[] | undefined) =>
  (values ?? []).filter((v): v is MediaValue => 'assetId' in v)

const asset = (v: MediaValue): AssetRef => ({
  assetId: v.assetId,
  kind: v.kind,
  mime: v.mime,
  ...(v.compositionSource ? { compositionSource: v.compositionSource } : {}),
})

export interface ArrangedClip {
  clipInstanceId?: string
  port?: string
  edgeId?: string
  segment?: SequenceClip['segment']
  narrative?: SequenceClip['narrative']
  sound?: SequenceClip['sound']
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
  lineGap?: number
  /** 进入这段的转场（不填跟随全局） */
  transition?: TransitionName
  transitionDuration?: number
}

/**
 * 按参数排好镜头：参数里记着的镜头按参数顺序在前，新连进来的按画布位置排在后面，
 * 已断开的设置丢掉。对白、音效没指定时按顺序对应第 n 段（别的段已经指定了的除外）。
 */
export function arrangeSequence(
  params: Pick<SequenceParams, 'clips'> & { instanceVersion?: 2 },
  inputs: Record<string, PortValue[]>,
): ArrangedClip[] {
  const clips = media(inputs.clips)
  // 写进某段 more 的台词只在那一段播，不参与按顺序自动对应
  const extra = new Set(params.clips.flatMap((c) => c.more ?? []))
  const allDialogue = media(inputs.dialogue)
  const dialogue = allDialogue.filter((v) => v.source === undefined || !extra.has(v.source))
  const sfx = media(inputs.sfx)
  if (params.instanceVersion === 2) {
    const claimed = new Set(params.clips.flatMap((c) => [c.dialogue, c.sfx]).filter(Boolean))
    const pick = (
      list: MediaValue[],
      choice: string | undefined,
      index: number,
      legacy: boolean,
    ) => {
      if (choice === '') return undefined
      if (choice !== undefined) return list.find((v) => v.source === choice)
      const auto = legacy ? list[index] : undefined
      return auto?.source && claimed.has(auto.source) ? undefined : auto
    }
    return params.clips.map((c, i) => {
      const legacy = c.sound === 'legacy'
      const value = c.segment
        ? { type: 'video' as const, ...c.segment.asset, source: c.source }
        : clips.find(
            (v) =>
              v.source === c.source &&
              v.sourcePort === c.port &&
              (!c.edgeId || v.edgeId === c.edgeId),
          )
      const noVoice = c.sound === 'native'
      return {
        ...c,
        clip: value ?? {
          type: 'video' as const,
          kind: 'video' as const,
          assetId: '',
          source: c.source,
        },
        in: c.in ?? 0,
        speed: c.speed ?? 1,
        volume: c.sound === 'voice' ? 0 : (c.volume ?? 1),
        lineDelay: c.lineDelay ?? 0,
        dialogue: noVoice ? undefined : pick(dialogue, c.dialogue, i, legacy),
        more: noVoice
          ? []
          : (c.more ?? []).flatMap((id) => allDialogue.filter((v) => v.source === id)),
        sfx: pick(sfx, c.sfx, i, legacy),
      }
    })
  }
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
      lineGap: s?.lineGap,
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

export type Cue = ComposeCue

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
  moreTranscripts: Array<Array<TranscriptSegment[] | undefined>> = [],
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
      at += duration + (c.lineGap ?? LINE_GAP)
    })
    let cues: Cue[] = []
    if (params.subtitles) {
      const span = lines.length ? lines.at(-1)!.start + lines.at(-1)!.duration - start : length
      if (c.subtitle?.trim())
        cues = [{ start: 0, end: span, text: c.subtitle.trim(), origin: 'manual' }]
      else
        cues = lines.flatMap((l, k) => {
          const offset = l.start - start
          const segs =
            k === 0 && c.dialogue ? transcripts[i] : moreTranscripts[i]?.[c.dialogue ? k - 1 : k]
          return dialogueCues((own[k]!.caption ?? '').trim(), segs, l.duration).map((q) => ({
            start: offset + q.start,
            end: offset + q.end,
            text: q.text,
            origin: segs?.some((segment) => segment.end > segment.start) ? 'asr' : 'estimated',
          }))
        })
      cues = cues
        .map((q) => ({
          ...q,
          source: subtitleSource(c, i),
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
    if (params.subtitleTrack && params.subtitles) {
      cues = params.subtitleTrack.cues
        .filter((q) => q.source === subtitleSource(c, i) && !q.hidden && q.text.trim())
        .map((q) => ({
          id: q.id,
          source: q.source,
          origin: q.origin ?? 'legacy',
          start: start + q.start,
          end: Math.min(start + q.end, total),
          text: q.text,
        }))
        .filter((q) => q.end > q.start)
    }
    return { start, length, lines, cues, transition }
  })
  return { clips, total }
}

const subtitleSource = (c: ArrangedClip, i: number) =>
  c.clipInstanceId ?? c.source ?? `clip:${i}:${c.clip.assetId}`

export const sequenceRowKey = (c: ArrangedClip, i = 0) => subtitleSource(c, i)

/** 只跟字幕的实际输入相关；混音、样式变化不会再次要求识别。 */
export function legacySubtitleInputKey(params: SequenceParams, arranged: ArrangedClip[]) {
  return JSON.stringify({
    model: params.asrTiming ? params.model : '',
    transition: params.transition,
    transitionDuration: params.transitionDuration,
    clips: arranged.map((c, i) => ({
      source: c.source ?? `clip:${i}:${c.clip.assetId}`,
      assetId: c.clip.assetId,
      in: c.in,
      out: c.out,
      speed: c.speed,
      delay: c.lineDelay,
      gap: c.lineGap,
      transition: c.transition,
      transitionDuration: c.transitionDuration,
      subtitle: c.subtitle,
      lines: clipLines(c).map((l) => ({
        source: l.source,
        assetId: l.assetId,
        caption: l.caption,
      })),
    })),
  })
}

export function subtitleInputKey(params: SequenceParams, arranged: ArrangedClip[]) {
  if (params.instanceVersion !== 2) return legacySubtitleInputKey(params, arranged)
  const old = JSON.parse(legacySubtitleInputKey(params, arranged))
  return JSON.stringify({
    version: 2,
    ...old,
    clips: old.clips.map((c: Record<string, unknown>, i: number) => ({
      ...c,
      source: subtitleSource(arranged[i]!, i),
      sound: arranged[i]!.sound,
    })),
  })
}

export function subtitleTrackStale(params: SequenceParams, arranged: ArrangedClip[]) {
  const track = params.subtitleTrack
  const current =
    track?.keyVersion === 1 && track.legacySources
      ? legacySubtitleInputKey(
          params,
          arranged.map((c) => ({
            ...c,
            source: c.clipInstanceId
              ? (track.legacySources![c.clipInstanceId] ?? c.source)
              : c.source,
          })),
        )
      : subtitleInputKey(params, arranged)
  return !!track && track.inputKey !== current
}

/** 创建字幕轨不调用平台；识别结果由显式识别入口提供，全部对白都参与对齐。 */
export function createSubtitleTrack(
  params: SequenceParams,
  arranged: ArrangedClip[],
  durations: SequenceDurations,
  transcripts: Record<string, TranscriptSegment[]> = {},
): SequenceSubtitleTrack {
  const timeline = sequenceTimeline(
    { ...params, subtitleTrack: undefined, subtitles: true },
    arranged,
    durations,
    arranged.map((c) => (c.dialogue ? transcripts[c.dialogue.assetId] : undefined)),
    arranged.map((c) => c.more.map((m) => transcripts[m.assetId])),
  )
  return {
    ...unmappedSubtitleEvidence(params.subtitleTrack),
    inputKey: subtitleInputKey(params, arranged),
    cues: timeline.clips.flatMap((clip, i) =>
      clip.cues.map((q, k) => ({
        id: `${subtitleSource(arranged[i]!, i)}:${k}`,
        source: subtitleSource(arranged[i]!, i),
        start: Number(Math.max(0, q.start - clip.start).toFixed(3)),
        end: Number(Math.max(0, q.end - clip.start).toFixed(3)),
        text: q.text,
        origin: q.origin ?? 'estimated',
        hidden: false,
      })),
    ),
  }
}

/** Explicit cue editing may promote a fresh migrated key, never a stale track. */
export function commitSubtitleTrackEdit(
  params: SequenceParams,
  arranged: ArrangedClip[],
  cues: SequenceSubtitleTrack['cues'],
): SequenceSubtitleTrack {
  if (subtitleTrackStale(params, arranged)) throw new Error('字幕已过期，不能直接沿用旧时间')
  const sources = new Set(arranged.map(subtitleSource))
  if (
    new Set(cues.map((c) => c.id)).size !== cues.length ||
    cues.some((c) => !sources.has(c.source))
  )
    throw new Error('字幕条目不属于当前剪辑实例')
  return {
    ...unmappedSubtitleEvidence(params.subtitleTrack),
    inputKey: subtitleInputKey(params, arranged),
    cues: cues.map((c) => ({ ...c })),
  }
}

/** Preserve relative manual cues only for the same actual row contents after explicit layout edits. */
export function retainInstanceSubtitleTrack(
  before: SequenceParams,
  oldRows: ArrangedClip[],
  after: SequenceParams,
  newRows: ArrangedClip[],
): SequenceSubtitleTrack | undefined {
  if (!before.subtitleTrack) return undefined
  if (subtitleTrackStale(before, oldRows)) throw new Error('字幕已过期，不能直接沿用旧时间')
  const byId = new Map(oldRows.map((r, i) => [subtitleSource(r, i), r]))
  if (
    newRows.some((row, i) => {
      const old = byId.get(subtitleSource(row, i))
      return !old || legacySubtitleInputKey(before, [old]) !== legacySubtitleInputKey(after, [row])
    })
  )
    throw new Error('剪辑实际素材或时间已变化，请重新核对字幕')
  const active = new Set(newRows.map(subtitleSource))
  return {
    ...unmappedSubtitleEvidence(before.subtitleTrack),
    inputKey: subtitleInputKey(after, newRows),
    cues: before.subtitleTrack.cues.filter((c) => active.has(c.source)).map((c) => ({ ...c })),
  }
}

export function duplicateInstanceSubtitleTrack(
  before: SequenceParams,
  oldRows: ArrangedClip[],
  after: SequenceParams,
  newRows: ArrangedClip[],
  fromId: string,
  toId: string,
): SequenceSubtitleTrack | undefined {
  if (!before.subtitleTrack) return undefined
  const original = oldRows.find((r, i) => subtitleSource(r, i) === fromId)
  const added = newRows.find((r, i) => subtitleSource(r, i) === toId)
  if (
    !original ||
    !added ||
    fromId === toId ||
    oldRows.some((r, i) => subtitleSource(r, i) === toId) ||
    newRows.length !== oldRows.length + 1 ||
    JSON.stringify([original.clip.assetId, original.in, original.out, original.speed]) !==
      JSON.stringify([added.clip.assetId, added.in, added.out, added.speed])
  )
    throw new Error('新增实例不是原素材的明确副本')
  const withoutAdded = newRows.filter((r, i) => subtitleSource(r, i) !== toId)
  const retained = retainInstanceSubtitleTrack(before, oldRows, after, withoutAdded)!
  return {
    ...unmappedSubtitleEvidence(before.subtitleTrack),
    inputKey: subtitleInputKey(after, newRows),
    cues: [
      ...retained.cues,
      ...before.subtitleTrack.cues
        .filter((c) => c.source === fromId)
        .map((c, i) => ({ ...c, id: `${toId}:${c.id}:${i}`, source: toId })),
    ],
  }
}

function unmappedSubtitleEvidence(track: SequenceSubtitleTrack | undefined) {
  return track?.unmappedCues?.length
    ? {
        unmappedCues: track.unmappedCues.map((c) => ({ ...c })),
        ...(track.legacyTrack !== undefined ? { legacyTrack: track.legacyTrack } : {}),
      }
    : {}
}

/** 所有导出入口共用的门禁；绝不在导出时隐式调用付费识别。 */
export function subtitleExportProblem(params: SequenceParams, arranged: ArrangedClip[]) {
  if (!params.subtitles) return undefined
  if (subtitleTrackStale(params, arranged))
    return '字幕已过期，请在序列编辑器按当前素材重建或重新识别字幕后再导出'
  if (params.asrTiming && !params.subtitleTrack)
    return '请先在序列编辑器识别全部对白并检查字幕，再导出'
  const invalid = params.subtitleTrack?.cues.some(
    (q) => !q.hidden && (q.end <= q.start || !q.text.trim()),
  )
  if (invalid) return '有字幕的结束时间不晚于开始时间，或文本为空，请修正或隐藏后再导出'
  return undefined
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

/** 可见叠加轨必须能解析；隐藏轨保留参数，允许断开后先隐藏再导出。 */
export function sequenceOverlayProblem(
  params: Pick<SequenceParams, 'overlays'>,
  arranged: ArrangedClip[],
  overlayInputs: PortValue[] | undefined,
  timeline?: Timeline,
): string | undefined {
  if ((params.overlays?.length ?? 0) > 200) return '叠加轨不能超过 200 个'
  const ids = new Set<string>()
  const inputs = media(overlayInputs).filter((value) => value.type === 'video')
  for (const value of params.overlays ?? []) {
    const parsed = SequenceOverlay.safeParse(value)
    if (!parsed.success) return '叠加轨的时间、速度或位置参数不合法，请修正后再导出'
    const overlay = parsed.data
    if (ids.has(overlay.id)) return '叠加轨标识重复，请重新添加该轨道'
    ids.add(overlay.id)
    if (overlay.hidden) continue
    if (!inputs.some((input) => input.source === overlay.source))
      return '叠加轨的来源已断开或没有视频结果，请重新连接、替换或隐藏后再导出'
    const index =
      overlay.clip === undefined ? -1 : arranged.findIndex((clip) => clip.source === overlay.clip)
    if (overlay.clip !== undefined && index < 0)
      return '叠加轨锚定的镜头已断开，请重新选择镜头或隐藏后再导出'
    if (timeline) {
      const clip = index < 0 ? undefined : timeline.clips[index]
      const room = clip ? clip.length : timeline.total
      if (overlay.start >= room || room <= 0)
        return '叠加轨起点已超出所属镜头或成片，请调整时间或隐藏后再导出'
    }
  }
  return undefined
}

/** 先按背景时间线解析位置，再截到锚定镜头末尾；背景变速不会再次作用于叠加素材。 */
export function sequenceOverlays(
  params: Pick<SequenceParams, 'overlays'>,
  arranged: ArrangedClip[],
  overlayInputs: PortValue[] | undefined,
  timeline: Timeline,
): ComposeOverlay[] {
  const problem = sequenceOverlayProblem(params, arranged, overlayInputs, timeline)
  if (problem) throw new Error(problem)
  const inputs = media(overlayInputs)
  return (params.overlays ?? []).flatMap((overlay) => {
    if (overlay.hidden) return []
    const index =
      overlay.clip === undefined ? -1 : arranged.findIndex((clip) => clip.source === overlay.clip)
    const clip = index < 0 ? undefined : timeline.clips[index]
    const start = (clip?.start ?? 0) + overlay.start
    const end = Math.min(start + overlay.duration, clip ? clip.start + clip.length : timeline.total)
    return [
      {
        id: overlay.id,
        asset: {
          ...asset(inputs.find((input) => input.source === overlay.source)!),
          kind: 'video' as const,
        },
        start,
        duration: end - start,
        in: overlay.in,
        speed: overlay.speed,
        x: overlay.x,
        y: overlay.y,
        width: overlay.width,
        height: overlay.height,
        opacity: overlay.opacity,
      },
    ]
  })
}

/** 生成合成参数：画面、各段声音、配乐（循环铺满，结尾淡出）、字幕和转场 */
export function sequenceSpec(
  params: SequenceParams,
  arranged: ArrangedClip[],
  durations: SequenceDurations,
  music: PortValue[] | undefined,
  name?: string,
  transcripts?: Array<TranscriptSegment[] | undefined>,
  overlayInputs?: PortValue[],
): ComposeSpec {
  const problem = subtitleExportProblem(params, arranged)
  if (problem) throw new Error(problem)
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
          ...(c.source
            ? {
                provenance: {
                  source: c.source,
                  port: c.port ?? c.clip.sourcePort,
                  edgeId: c.edgeId ?? c.clip.edgeId,
                  clipInstanceId: c.clipInstanceId,
                  segmentId: c.segment?.segmentId,
                  narrative: c.narrative,
                  origin: c.segment?.origin ?? c.clip.generationOrigin,
                  selection:
                    c.segment?.selection ??
                    (c.clip.resultId && c.clip.runId && c.clip.sourceCanvasId
                      ? {
                          canvasId: c.clip.sourceCanvasId,
                          nodeId: c.source,
                          port: c.port ?? c.clip.sourcePort ?? 'video',
                          resultId: c.clip.resultId,
                          runId: c.clip.runId,
                        }
                      : undefined),
                },
              }
            : {}),
        },
      ]
    }),
    audio,
    ...(params.overlays?.length
      ? { overlays: sequenceOverlays(params, arranged, overlayInputs, tl) }
      : {}),
    subtitles: cues.length
      ? {
          cues,
          style: SUBTITLE_STYLE_IDS[params.subtitleStyle],
          ...(params.subtitleRender !== 'static' ? { render: params.subtitleRender } : {}),
          ...(params.subtitleRender === 'animated' ? { animation: params.subtitleAnimation } : {}),
        }
      : undefined,
    loudnorm: params.loudnorm || undefined,
    name,
  }
}

/** The same interval convention used by sequenceTimeline and compose. Includes every overlapping use. */
export function sequenceSourceMap(spec: ComposeSpec): CompositionSource[] {
  let at = 0
  return spec.clips.flatMap((c, i) => {
    const tr = i ? (c.transition ?? spec.transition) : undefined
    if (overlapping(tr)) at -= tr!.duration
    const start = at,
      speed = c.speed ?? 1,
      out = c.out ?? c.in
    at += Math.max(0, out - c.in) / speed
    return c.provenance
      ? [
          {
            ...c.provenance,
            assetId: c.asset.assetId,
            sourceIn: c.in,
            sourceOut: out,
            speed,
            start,
            end: at,
          },
        ]
      : []
  })
}

export function sequenceSourcesAt<
  T extends { start: number; end: number; sourceIn?: number; speed?: number },
>(sources: readonly T[], time: number) {
  return sources
    .filter((s) => time >= s.start && time < s.end)
    .map((s) => ({
      ...s,
      sourceTime:
        s.sourceIn === undefined ? undefined : s.sourceIn + (time - s.start) * (s.speed ?? 1),
    }))
}

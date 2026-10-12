import {
  type AssetRef,
  type ComposeAudio,
  type ComposeSpec,
  defineNode,
  type PortValue,
  type SubtitleStyle,
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

/**
 * 生成合成参数。对白从所属镜头开头播放，可以延续到下一段有对白的镜头开始；
 * 字幕跟着对白的时长，没有对白时铺满这段镜头。配乐从头循环到尾，结尾淡出。
 */
export function sequenceSpec(
  params: SequenceParams,
  arranged: ArrangedClip[],
  durations: { clips: number[]; dialogue: Array<number | undefined> },
  music: PortValue[] | undefined,
  name?: string,
): ComposeSpec {
  const [width, height] = SIZES[params.resolution][params.aspectRatio]
  const lengths = arranged.map((c, i) => clipLength(c, durations.clips[i] ?? 0))
  const starts: number[] = []
  let t = 0
  for (const len of lengths) {
    starts.push(t)
    t += len
  }
  const total = t
  const audio: ComposeAudio[] = []
  const cues: Array<{ start: number; end: number; text: string }> = []
  arranged.forEach((c, i) => {
    const start = starts[i]!
    if (lengths[i] === 0) return
    // 下一段有对白的镜头开始前，这段对白都可以继续
    let until = total
    for (let j = i + 1; j < arranged.length; j++) {
      if (arranged[j]!.dialogue && lengths[j]! > 0) {
        until = starts[j]!
        break
      }
    }
    let spoken: number | undefined
    if (c.dialogue) {
      spoken = Math.min(durations.dialogue[i] ?? until - start, until - start)
      audio.push({
        asset: asset(c.dialogue),
        start,
        duration: spoken,
        volume: params.dialogueVolume,
      })
    }
    if (c.sfx)
      audio.push({ asset: asset(c.sfx), start, duration: lengths[i], volume: params.sfxVolume })
    const text = (c.subtitle ?? c.dialogue?.caption ?? '').trim()
    if (params.subtitles && text) {
      const end = start + Math.max(spoken ?? lengths[i]!, Math.min(1, lengths[i]!))
      cues.push({ start, end: Math.min(end, total), text })
    }
  })
  for (const m of media(music)) {
    audio.push({ asset: asset(m), start: 0, volume: params.musicVolume, loop: true, fadeOut: 2 })
  }
  return {
    width,
    height,
    fps: 30,
    clips: arranged.flatMap((c, i) =>
      lengths[i]! > 0
        ? [{ asset: asset(c.clip), in: c.in, out: c.in + lengths[i]!, volume: params.clipVolume }]
        : [],
    ),
    audio,
    subtitles: cues.length ? { cues, style: STYLE_IDS[params.subtitleStyle] } : undefined,
    name,
  }
}

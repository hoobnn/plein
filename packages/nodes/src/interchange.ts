import {
  type AssetRef,
  type ComposeCue,
  type ComposeSpec,
  type ComposeTransition,
  overlapping,
} from '@plein/plugin-sdk'
import { sequenceSourceMap } from './sequence'

/**
 * 把序列导出成专业剪辑软件能打开的工程：OpenTimelineIO（DaVinci Resolve、Kdenlive 等）
 * 和 FCPXML（Final Cut Pro、DaVinci Resolve），外加 SRT 字幕。
 * 媒体文件和工程放在同一个文件夹里，工程里用相对路径引用。
 *
 * 时间按帧取整（成片帧率）。重叠转场在工程里表示成两段各让出一半的标准转场：
 * 前一段在原剪切点前 d/2 结束、后一段在原剪切点后 d/2 开始，转场盖住这 d 秒，总时长和成片一致。
 */

export interface InterchangeMedia {
  /** 相对工程文件的路径，如 media/01 镜头.mp4 */
  path: string
  name: string
  duration: number
  width?: number
  height?: number
  hasVideo: boolean
  hasAudio: boolean
  /** 唯一音频流的真实属性；未知或多流时不推定。 */
  audioChannels?: number
  audioSampleRate?: number
}

export type MediaLookup = (ref: AssetRef) => InterchangeMedia

/** 画面轨上的一段（都是成片时间，秒） */
interface Placed {
  media: InterchangeMedia
  /** 在轨道上的起点和时长（已让出转场的一半） */
  offset: number
  duration: number
  /** 素材里从哪开始（秒，素材时间） */
  source: number
  speed: number
  volume: number
  /** 进入这段的重叠转场时长 */
  transitionIn?: ComposeTransition
  provenance?: ComposeSpec['clips'][number]['provenance']
}

interface PlacedSound {
  media: InterchangeMedia
  start: number
  duration: number
  source: number
  volume: number
  role: 'dialogue' | 'music'
}

const TRANSITION_NAMES: Record<ComposeTransition['type'], string> = {
  fade: '淡入淡出',
  dissolve: '叠化',
  wipe: '划像',
  slide: '推移',
  flash: '闪白',
}

/** 按成片的规则排好画面轨和声音轨 */
export function placeSequence(spec: ComposeSpec, lookup: MediaLookup) {
  const fps = spec.fps
  const frame = (t: number) => Math.round(t * fps) / fps
  const clips = spec.clips.map((c, i) => {
    const media = lookup(c.asset)
    const speed = c.speed && c.speed > 0 ? c.speed : 1
    const length = (Math.min(c.out ?? media.duration, media.duration) - c.in) / speed
    const tr = i > 0 ? (c.transition ?? spec.transition) : undefined
    return { c, media, speed, length: Math.max(0, length), tr }
  })
  const placed: Placed[] = []
  let t = 0
  clips.forEach((x, i) => {
    const into = overlapping(x.tr) ? x.tr!.duration : 0
    const next = clips[i + 1]?.tr
    const out = overlapping(next) ? next!.duration : 0
    const start = t - into
    // 让出转场的一半：前面晚开始 into/2，后面早结束 out/2
    const offset = frame(start + into / 2)
    const end = frame(start + x.length - out / 2)
    placed.push({
      media: x.media,
      offset,
      duration: Math.max(1 / fps, frame(end - offset)),
      source: x.c.in + (offset - start) * x.speed,
      speed: x.speed,
      volume: x.c.volume,
      transitionIn: into ? x.tr : undefined,
      ...(x.c.provenance ? { provenance: x.c.provenance } : {}),
    })
    t = start + x.length
  })
  const total = frame(t)

  const sounds: PlacedSound[] = []
  for (const a of spec.audio) {
    const media = lookup(a.asset)
    const room = Math.max(0, total - a.start)
    const length = Math.min(a.duration ?? (a.loop ? room : media.duration), room)
    if (length <= 0 || media.duration <= 0) continue
    const role = a.loop ? 'music' : 'dialogue'
    // 循环的配乐拆成首尾相接的几段
    for (let at = 0; at < length - 1e-3; at += media.duration) {
      const d = Math.min(media.duration, length - at)
      sounds.push({
        media,
        start: frame(a.start + at),
        duration: frame(d),
        source: 0,
        volume: a.volume,
        role,
      })
      if (!a.loop) break
    }
  }
  const overlays = (spec.overlays ?? []).flatMap((overlay, order) => {
    const start = frame(overlay.start)
    const duration = frame(Math.min(overlay.duration, total - start))
    return duration > 0
      ? [{ ...overlay, start, duration, media: lookup(overlay.asset), order }]
      : []
  })
  return { placed, sounds, overlays, total, fps }
}

// ── OpenTimelineIO ──

const rt = (seconds: number, rate: number) => ({
  OTIO_SCHEMA: 'RationalTime.1',
  rate,
  value: Math.round(seconds * rate),
})
const range = (start: number, duration: number, rate: number) => ({
  OTIO_SCHEMA: 'TimeRange.1',
  start_time: rt(start, rate),
  duration: rt(duration, rate),
})

function otioRef(m: InterchangeMedia, rate: number) {
  return {
    OTIO_SCHEMA: 'ExternalReference.1',
    metadata: {},
    name: m.name,
    available_range: range(0, m.duration, rate),
    available_image_bounds: null,
    target_url: m.path,
  }
}

function otioClip(
  m: InterchangeMedia,
  source: number,
  duration: number,
  rate: number,
  extra: {
    speed?: number
    volume?: number
    provenance?: ComposeSpec['clips'][number]['provenance']
    /** 叠加轨的几何与不透明度；导入软件不会自动识别，写进元数据供人工还原 */
    overlay?: Omit<NonNullable<ComposeSpec['overlays']>[number], 'asset'>
  } = {},
) {
  return {
    OTIO_SCHEMA: 'Clip.2',
    metadata:
      extra.volume !== undefined || extra.provenance || extra.overlay
        ? {
            plein: {
              ...(extra.volume !== undefined ? { volume: extra.volume } : {}),
              ...(extra.provenance ? { provenance: extra.provenance } : {}),
              ...(extra.overlay ? { overlay: extra.overlay } : {}),
            },
          }
        : {},
    name: m.name,
    source_range: range(source, duration, rate),
    effects:
      extra.speed && extra.speed !== 1
        ? [
            {
              OTIO_SCHEMA: 'LinearTimeWarp.1',
              metadata: {},
              name: '',
              effect_name: 'LinearTimeWarp',
              time_scalar: extra.speed,
            },
          ]
        : [],
    markers: [],
    enabled: true,
    media_references: { DEFAULT_MEDIA: otioRef(m, rate) },
    active_media_reference_key: 'DEFAULT_MEDIA',
  }
}

const otioGap = (duration: number, rate: number) => ({
  OTIO_SCHEMA: 'Gap.1',
  metadata: {},
  name: '',
  source_range: range(0, duration, rate),
  effects: [],
  markers: [],
  enabled: true,
})

const otioTrack = (name: string, kind: 'Video' | 'Audio', children: unknown[]) => ({
  OTIO_SCHEMA: 'Track.1',
  metadata: {},
  name,
  source_range: null,
  effects: [],
  markers: [],
  enabled: true,
  children,
  kind,
})

/** 声音按起点排进一条轨，中间补空隙；重叠的放进下一条轨 */
function soundTracks(sounds: PlacedSound[], rate: number, name: string) {
  const lanes: PlacedSound[][] = []
  for (const s of [...sounds].sort((a, b) => a.start - b.start)) {
    const lane = lanes.find((l) => {
      const last = l.at(-1)!
      return last.start + last.duration <= s.start + 1e-6
    })
    if (lane) lane.push(s)
    else lanes.push([s])
  }
  return lanes.map((lane, k) => {
    const children: unknown[] = []
    let at = 0
    for (const s of lane) {
      if (s.start > at + 1e-6) children.push(otioGap(s.start - at, rate))
      children.push(otioClip(s.media, s.source, s.duration, rate, { volume: s.volume }))
      at = s.start + s.duration
    }
    return otioTrack(lanes.length > 1 ? `${name} ${k + 1}` : name, 'Audio', children)
  })
}

export function sequenceOtio(spec: ComposeSpec, lookup: MediaLookup) {
  const { placed, sounds, overlays, fps: rate } = placeSequence(spec, lookup)
  const video: unknown[] = []
  const original: unknown[] = []
  const sounding = (p: Placed | undefined) => !!p && p.media.hasAudio && p.volume > 0
  placed.forEach((p, i) => {
    const tr = p.transitionIn
    if (tr) {
      const half = tr.duration / 2
      const transition = {
        OTIO_SCHEMA: 'Transition.1',
        metadata: { plein: { type: tr.type } },
        name: TRANSITION_NAMES[tr.type],
        in_offset: rt(half, rate),
        out_offset: rt(half, rate),
        transition_type: 'SMPTE_Dissolve',
      }
      video.push(transition)
      if (sounding(p) && sounding(placed[i - 1])) original.push({ ...transition, name: '交叉淡化' })
    }
    video.push(
      otioClip(p.media, p.source, p.duration, rate, { speed: p.speed, provenance: p.provenance }),
    )
    original.push(
      sounding(p)
        ? otioClip(p.media, p.source, p.duration, rate, {
            speed: p.speed,
            volume: p.volume,
            provenance: p.provenance,
          })
        : otioGap(p.duration, rate),
    )
  })
  const tracks = [
    otioTrack('画面', 'Video', video),
    ...overlays.map((overlay) => {
      const clip = otioClip(overlay.media, overlay.in, overlay.duration, rate, {
        speed: overlay.speed,
      })
      const { media: _media, asset: _asset, ...settings } = overlay
      clip.metadata = { plein: { overlay: settings } }
      return otioTrack(`叠加 ${overlay.order + 1}: ${overlay.media.name}`, 'Video', [
        ...(overlay.start > 0 ? [otioGap(overlay.start, rate)] : []),
        clip,
      ])
    }),
    ...(placed.some(sounding) ? [otioTrack('原声', 'Audio', original)] : []),
    ...soundTracks(
      sounds.filter((s) => s.role === 'dialogue'),
      rate,
      '对白音效',
    ),
    ...soundTracks(
      sounds.filter((s) => s.role === 'music'),
      rate,
      '配乐',
    ),
  ]
  const timeline = {
    OTIO_SCHEMA: 'Timeline.1',
    metadata: {
      plein: {
        width: spec.width,
        height: spec.height,
        ...(spec.clips.some((c) => c.provenance)
          ? { clipMap: { version: 1, sources: sequenceSourceMap(spec) } }
          : {}),
        ...(spec.subtitles ? { subtitles: spec.subtitles } : {}),
      },
    },
    name: spec.name ?? '序列',
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: {},
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      children: tracks,
    },
  }
  return `${JSON.stringify(timeline, null, 2)}\n`
}

// ── FCPXML ──

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** FCPXML 的时间：帧数 / 帧率，化成最简分数 */
function fcpTime(seconds: number, fps: number) {
  const frames = Math.round(seconds * fps)
  if (frames === 0) return '0s'
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  const g = gcd(Math.abs(frames), fps)
  const den = fps / g
  return den === 1 ? `${frames / g}s` : `${frames / g}/${den}s`
}

const db = (v: number) => (v <= 0 ? -96 : Math.round(20 * Math.log10(v) * 10) / 10)

/** Final Cut 内置的「交叉叠化」；FCPXML 里划像、推移、闪白也用它（其他转场的 ID 因版本而异） */
const CROSS_DISSOLVE = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265'

export function sequenceFcpxml(spec: ComposeSpec, lookup: MediaLookup) {
  const { placed, sounds, overlays, total, fps } = placeSequence(spec, lookup)
  const T = (s: number) => fcpTime(s, fps)
  const assets = new Map<string, { id: string; media: InterchangeMedia }>()
  const assetId = (m: InterchangeMedia) => {
    let a = assets.get(m.path)
    if (!a) {
      a = { id: `r${assets.size + 3}`, media: m }
      assets.set(m.path, a)
    }
    return a.id
  }
  for (const p of placed) assetId(p.media)
  for (const s of sounds) assetId(s.media)
  for (const overlay of overlays) assetId(overlay.media)

  const volume = (v: number) => (v === 1 ? '' : `<adjust-volume amount="${db(v)}dB"/>`)
  // 声音挂在它开始时所在的那段画面上，偏移用那段画面自己的时间（素材时间）
  const anchored = (p: Placed, next: Placed | undefined) =>
    sounds
      .filter((s) => s.start >= p.offset - 1e-6 && (!next || s.start < next.offset - 1e-6))
      .map((s) => {
        const lane = s.role === 'music' ? -2 : -1
        const offset = p.source + (s.start - p.offset) * p.speed
        return `              <asset-clip ref="${assetId(s.media)}" lane="${lane}" offset="${T(offset)}" name="${xml(s.media.name)}" start="${T(s.source)}" duration="${T(s.duration)}" audioRole="${s.role === 'music' ? 'music' : 'dialogue'}">${volume(s.volume)}</asset-clip>`
      })

  const spine: string[] = []
  placed.forEach((p, i) => {
    const tr = p.transitionIn
    if (tr)
      spine.push(
        `            <transition name="${TRANSITION_NAMES[tr.type]}" offset="${T(p.offset - tr.duration / 2)}" duration="${T(tr.duration)}"><filter-video ref="r2" name="Cross Dissolve"/></transition>`,
      )
    const retime =
      p.speed !== 1
        ? `<timeMap><timept time="${T(p.source)}" value="${T(p.source)}" interp="linear"/><timept time="${T(p.source + p.duration)}" value="${T(p.source + p.duration * p.speed)}" interp="linear"/></timeMap>`
        : ''
    const children = anchored(p, placed[i + 1])
    spine.push(
      `            <asset-clip ref="${assetId(p.media)}" offset="${T(p.offset)}" name="${xml(p.media.name)}" start="${T(p.source)}" duration="${T(p.duration)}">${retime}${p.media.hasAudio ? volume(p.volume) : ''}${children.length ? `\n${children.join('\n')}\n            ` : ''}</asset-clip>`,
    )
  })

  // 用无变速父 clip 的时钟连接叠加，不能把其挂在某个已变速背景素材下。
  const decimal = (value: number) => Number(value.toFixed(8))
  const overlayClip = (overlay: (typeof overlays)[number]) => {
    const retime =
      overlay.speed !== 1
        ? `<timeMap><timept time="${T(overlay.in)}" value="${T(overlay.in)}" interp="linear"/><timept time="${T(overlay.in + overlay.duration)}" value="${T(overlay.in + overlay.duration * overlay.speed)}" interp="linear"/></timeMap>`
        : ''
    const position = `${decimal((((overlay.x + overlay.width / 2 - 0.5) * spec.width) / spec.height) * 100)} ${decimal((0.5 - overlay.y - overlay.height / 2) * 100)}`
    const scale = `${decimal((spec.width * overlay.width) / (overlay.media.width ?? spec.width))} ${decimal((spec.height * overlay.height) / (overlay.media.height ?? spec.height))}`
    return `              <asset-clip ref="${assetId(overlay.media)}" lane="${overlay.order + 1}" offset="${T(overlay.start)}" name="${xml(overlay.id)}" start="${T(overlay.in)}" duration="${T(overlay.duration)}" srcEnable="video">${retime}<adjust-conform type="none"/><adjust-transform position="${position}" scale="${scale}"/><adjust-blend amount="${overlay.opacity}"/></asset-clip>`
  }
  const body = overlays.length
    ? [
        `            <clip name="画面与叠加" offset="0s" start="0s" duration="${T(total)}" format="r1">`,
        '              <spine>',
        ...spine,
        '              </spine>',
        ...overlays.map(overlayClip),
        '            </clip>',
      ].join('\n')
    : spine.join('\n')

  // 素材采样率不同于 sequence 的 48k 混音；未知属性由导入软件读取原文件。
  // ffprobe 流数不能据此确定 FCP 音频 source 组织，因此不猜 audioSources。
  const audioAttributes = (media: InterchangeMedia) => {
    if (!media.hasAudio) return ''
    return (
      [
        ['audioChannels', media.audioChannels],
        ['audioRate', media.audioSampleRate],
      ] as const
    )
      .filter(([, value]) => value !== undefined && Number.isInteger(value) && value > 0)
      .map(([key, value]) => ` ${key}="${value}"`)
      .join('')
  }
  const resources = [
    `    <format id="r1" frameDuration="${T(1 / fps)}" width="${spec.width}" height="${spec.height}"/>`,
    `    <effect id="r2" name="Cross Dissolve" uid="${CROSS_DISSOLVE}"/>`,
    ...[...assets.values()].flatMap(({ id, media: m }) =>
      m.hasVideo && m.width && m.height
        ? [
            `    <format id="f${id}" frameDuration="${T(1 / fps)}" width="${m.width}" height="${m.height}"/>`,
          ]
        : [],
    ),
    ...[...assets.values()].map(
      ({ id, media: m }) =>
        `    <asset id="${id}" name="${xml(m.name)}" start="0s" duration="${T(m.duration)}" hasVideo="${m.hasVideo ? 1 : 0}" hasAudio="${m.hasAudio ? 1 : 0}"${m.hasVideo ? ` format="${m.width && m.height ? `f${id}` : 'r1'}"` : ''}${audioAttributes(m)}>\n      <media-rep kind="original-media" src="${xml(encodeURI(m.path))}"/>\n    </asset>`,
    ),
  ]
  const name = xml(spec.name ?? '序列')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
${resources.join('\n')}
  </resources>
  <library>
    <event name="${name}">
      <project name="${name}">
        <sequence format="r1" duration="${T(total)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${body}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`
}

// ── SRT ──

function srtTime(t: number) {
  const ms = Math.max(0, Math.round(t * 1000))
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

export function subtitleSrt(cues: ComposeCue[]) {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.trim()}\n`)
    .join('\n')
}

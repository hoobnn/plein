import {
  type ArrangedClip,
  clipLines,
  duckEnvelope,
  MUSIC_FADE,
  type SequenceParams,
  sequenceSize,
  type Timeline,
} from '@plein/nodes'
import { overlapping } from '@plein/plugin-sdk'
import { envelopeAt, type Scene, type SceneClip, type SceneSound } from './engine'

/** 两条包络相乘：在两边所有拐点上取值（配乐的闪避 × 结尾淡出） */
function multiply(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]> {
  if (!a.length) return b
  if (!b.length) return a
  const xs = [...new Set([...a, ...b].map(([x]) => x))].sort((x, y) => x - y)
  return xs.map((x) => [x, envelopeAt(a, x) * envelopeAt(b, x)])
}

/**
 * 把时间线换成预览引擎要的场景：画面各段、各轨声音和它们的音量包络。
 * 和导出（sequenceSpec → compose）同一套规则：镜头原声随转场交叉淡化或经黑场淡入淡出，
 * 对白、音效按段落位，配乐循环铺满、对白时压低、结尾淡出。
 */
export function previewScene(
  rows: Array<ArrangedClip & { pending?: boolean }>,
  timeline: Timeline,
  params: SequenceParams,
  music?: string,
): Scene {
  const { total } = timeline
  const seen = new Map<string, number>()
  const clips = rows.map((row, i): SceneClip => {
    const c = timeline.clips[i]!
    const id = row.clip.assetId
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    return {
      key: `${id}#${n}`,
      assetId: row.pending ? undefined : id,
      start: c.start,
      length: c.length,
      in: row.in,
      speed: row.speed,
      transition: c.transition,
    }
  })
  const real = clips.filter((c) => c.length > 0)
  const sounds: SceneSound[] = []
  // 转场两侧的原声：重叠转场交叉淡化整个重叠段，经黑场各淡一半
  const edge = (tr: SceneClip['transition']) =>
    !tr ? 0 : overlapping(tr) ? tr.duration : tr.duration / 2
  real.forEach((c, k) => {
    const row = rows[clips.indexOf(c)]!
    const gain = params.clipVolume * row.volume
    if (!c.assetId || gain <= 0) return
    const end = c.start + c.length
    const env: Array<[number, number]> = []
    const into = edge(c.transition)
    const out = edge(real[k + 1]?.transition)
    if (into) env.push([c.start, 0], [c.start + into, 1])
    if (out) env.push([end - out, 1], [end, 0])
    sounds.push({
      assetId: c.assetId,
      start: c.start,
      offset: c.in,
      duration: c.length,
      gain,
      rate: c.speed !== 1 ? c.speed : undefined,
      envelope: env.length ? env : undefined,
    })
  })
  rows.forEach((row, i) => {
    const c = timeline.clips[i]!
    if (c.length === 0) return
    const own = clipLines(row)
    c.lines.forEach((l, k) =>
      sounds.push({
        assetId: own[k]!.assetId,
        start: l.start,
        offset: 0,
        duration: l.duration,
        gain: params.dialogueVolume,
      }),
    )
    if (row.sfx)
      sounds.push({
        assetId: row.sfx.assetId,
        start: c.start,
        offset: 0,
        duration: c.length,
        gain: params.sfxVolume,
      })
  })
  if (music && total > 0) {
    const fade: Array<[number, number]> =
      total > MUSIC_FADE
        ? [
            [total - MUSIC_FADE, 1],
            [total, 0],
          ]
        : []
    const envelope = multiply(params.duck ? duckEnvelope(timeline) : [], fade)
    sounds.push({
      assetId: music,
      start: 0,
      offset: 0,
      duration: total,
      gain: params.musicVolume,
      loop: true,
      envelope: envelope.length ? envelope : undefined,
    })
  }
  return { ...sequenceSize(params), total, clips, sounds }
}

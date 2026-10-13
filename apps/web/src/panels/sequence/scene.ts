import {
  type ArrangedClip,
  clipLines,
  type SequenceParams,
  sequenceSize,
  type Timeline,
} from '@plein/nodes'
import type { Scene, SceneClip, SceneSound } from './engine'

/** 结尾配乐淡出时长，和导出一致 */
const MUSIC_FADE = 2

/**
 * 把时间线换成预览引擎要的场景：画面各段、各轨声音和它们的音量包络。
 * 和导出（sequenceSpec → compose）同一套规则：镜头原声随转场交叉淡化或经黑场淡入淡出，
 * 对白、音效按段落位，配乐循环铺满、结尾淡出。
 */
export function previewScene(
  rows: Array<ArrangedClip & { pending?: boolean }>,
  timeline: Timeline,
  params: SequenceParams,
  music?: string,
): Scene {
  const { total, transition } = timeline
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
    }
  })
  const real = clips.filter((c) => c.length > 0)
  const sounds: SceneSound[] = []
  for (const c of real) {
    if (!c.assetId || params.clipVolume <= 0) continue
    const end = c.start + c.length
    const env: Array<[number, number]> = []
    const edge =
      transition?.type === 'dissolve'
        ? transition.duration
        : transition?.type === 'fade'
          ? transition.duration / 2
          : 0
    if (edge && c !== real[0]) env.push([c.start, 0], [c.start + edge, 1])
    if (edge && c !== real.at(-1)) env.push([end - edge, 1], [end, 0])
    sounds.push({
      assetId: c.assetId,
      start: c.start,
      offset: c.in,
      duration: c.length,
      gain: params.clipVolume,
      envelope: env.length ? env : undefined,
    })
  }
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
  if (music && total > 0)
    sounds.push({
      assetId: music,
      start: 0,
      offset: 0,
      duration: total,
      gain: params.musicVolume,
      loop: true,
      envelope:
        total > MUSIC_FADE
          ? [
              [total - MUSIC_FADE, 1],
              [total, 0],
            ]
          : undefined,
    })
  return { ...sequenceSize(params), total, clips, sounds, transition }
}

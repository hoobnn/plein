import type { PortValue } from '@plein/plugin-sdk'
import { arrangeSequence, sequenceNode, sequenceTimeline } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { envelopeAt } from './engine'
import { previewScene } from './scene'

const video = (id: string): PortValue => ({ type: 'video', assetId: id, kind: 'video', source: id })
const audio = (id: string): PortValue => ({ type: 'audio', assetId: id, kind: 'audio', source: id })

function scene(overrides: Record<string, unknown>, music?: string) {
  const params = sequenceNode.params.parse(overrides)
  const rows = arrangeSequence(params, {
    clips: [video('a'), video('b'), video('a')],
    dialogue: [audio('line')],
  })
  const timeline = sequenceTimeline(params, rows, { clips: [2, 3, 2], dialogue: [1.5] })
  return previewScene(rows, timeline, params, music)
}

describe('previewScene', () => {
  it('同一素材出现两次各自一份解码；叠化时镜头原声交叉淡化', () => {
    const s = scene({ transition: '叠化', transitionDuration: 0.5 })
    expect(s.clips.map((c) => c.key)).toEqual(['a#0', 'b#0', 'a#1'])
    expect(s.total).toBeCloseTo(6)
    const [first, mid] = s.sounds.filter((x) => x.offset === 0 && x.gain === 1 && x.envelope)
    expect(first!.envelope).toEqual([
      [1.5, 1],
      [2, 0],
    ])
    expect(mid!.envelope).toEqual([
      [1.5, 0],
      [2, 1],
      [4, 1],
      [4.5, 0],
    ])
    expect(s.sounds.find((x) => x.assetId === 'line')).toMatchObject({ start: 0, duration: 1.5 })
  })

  it('配乐循环铺满，结尾 2 秒淡出；原声音量为 0 时不排镜头声', () => {
    const s = scene({ clipVolume: 0, duck: false }, 'bgm')
    expect(s.sounds.some((x) => x.assetId === 'a')).toBe(false)
    expect(s.sounds.find((x) => x.assetId === 'bgm')).toMatchObject({
      loop: true,
      duration: 7,
      envelope: [
        [5, 1],
        [7, 0],
      ],
    })
  })
})

describe('previewScene 配乐', () => {
  it('对白时压低和结尾淡出相乘；变速段的原声按速率播放', () => {
    const s = scene({ clips: [{ source: 'b', speed: 2 }] }, 'bgm')
    const music = s.sounds.find((x) => x.assetId === 'bgm')!
    expect(envelopeAt(music.envelope, 0.5)).toBeCloseTo(0.32)
    expect(envelopeAt(music.envelope, 3)).toBe(1)
    expect(envelopeAt(music.envelope, music.duration)).toBe(0)
    const b = s.clips.find((c) => c.key === 'b#0')!
    expect(b).toMatchObject({ speed: 2, length: 1 })
    expect(s.sounds.find((x) => x.assetId === 'b')).toMatchObject({ rate: 2, duration: 1 })
  })
})

describe('envelopeAt', () => {
  it('点之间线性，两端取端点值', () => {
    const env: Array<[number, number]> = [
      [1, 0],
      [2, 1],
    ]
    expect(envelopeAt(env, 0)).toBe(0)
    expect(envelopeAt(env, 1.5)).toBeCloseTo(0.5)
    expect(envelopeAt(env, 3)).toBe(1)
    expect(envelopeAt(undefined, 3)).toBe(1)
  })
})

describe('stable sequence instances', () => {
  const sharedFile = 'a'.repeat(64)
  const fixed = {
    version: 1,
    segmentId: 'shared',
    asset: { assetId: sharedFile, kind: 'video' },
    duration: 8,
  }
  const instance = (
    id: string,
    sound: 'native' | 'voice' | 'mix',
    extra: Record<string, unknown> = {},
  ) => ({
    clipInstanceId: id,
    source: 'fixed-view',
    port: 'video',
    segment: fixed,
    in: 0,
    out: 2,
    sound,
    ...extra,
  })
  it('keeps per-instance decoders through reorder, and replaces a decoder when that instance changes file', () => {
    const params = sequenceNode.params.parse({
      instanceVersion: 2,
      clips: [instance('a', 'native'), instance('b', 'native', { in: 4, out: 6 })],
    })
    const rows = arrangeSequence(params, {}),
      durations = { clips: [8, 8], dialogue: [undefined, undefined] }
    const first = previewScene(rows, sequenceTimeline(params, rows, durations), params)
    const reversed = [...rows].reverse()
    const reordered = previewScene(reversed, sequenceTimeline(params, reversed, durations), params)
    expect(first.clips.map((c) => c.key)).toEqual([...reordered.clips.map((c) => c.key)].reverse())
    expect(new Set(first.clips.map((c) => c.key)).size).toBe(2)
    const changed = rows.map((row, i) =>
      i ? row : { ...row, clip: { ...row.clip, assetId: 'replacement-file' } },
    )
    const next = previewScene(changed, sequenceTimeline(params, changed, durations), params)
    expect(next.clips[0]!.key).not.toBe(first.clips[0]!.key)
    expect(next.clips[1]!.key).toBe(first.clips[1]!.key)
  })
  it('native does not claim dialogue, voice disables native and mix explicitly uses both; playback offsets remain independent', () => {
    const params = sequenceNode.params.parse({
      instanceVersion: 2,
      clips: [
        instance('native', 'native', { dialogue: 'line' }),
        instance('voice', 'voice', { in: 4, out: 6, speed: 2, dialogue: 'line' }),
        instance('mix', 'mix', { dialogue: 'line' }),
      ],
    })
    const rows = arrangeSequence(params, { dialogue: [audio('line')] })
    const timeline = sequenceTimeline(params, rows, { clips: [8, 8, 8], dialogue: [1, 1, 1] })
    const result = previewScene(rows, timeline, params)
    const originals = result.sounds.filter((s) => s.assetId === sharedFile)
    expect(originals.map((s) => s.start)).toEqual([0, 3])
    expect(result.sounds.filter((s) => s.assetId === 'line').map((s) => [s.start, s.rate])).toEqual(
      [
        [2, undefined],
        [3, undefined],
      ],
    )
    expect(result.clips[1]).toMatchObject({ in: 4, speed: 2, length: 1 })
  })
})

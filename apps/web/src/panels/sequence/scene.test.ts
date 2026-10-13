import { arrangeSequence, sequenceNode, sequenceTimeline } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { envelopeAt } from './engine'
import { previewScene } from './scene'

const video = (id: string) => ({
  kind: 'video' as const,
  assetId: id,
  mime: 'video/mp4',
  source: id,
})
const audio = (id: string) => ({
  kind: 'audio' as const,
  assetId: id,
  mime: 'audio/wav',
  source: id,
})

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
    const s = scene({ clipVolume: 0 }, 'bgm')
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

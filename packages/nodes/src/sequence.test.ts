import type { PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vitest'
import { arrangeSequence, sequenceNode, sequenceSpec } from './sequence'

const video = (source: string): PortValue => ({
  type: 'video',
  assetId: `v-${source}`,
  kind: 'video',
  source,
})
const audio = (source: string, caption?: string): PortValue => ({
  type: 'audio',
  assetId: `a-${source}`,
  kind: 'audio',
  source,
  caption,
})
const params = (p: Record<string, unknown> = {}) => sequenceNode.params.parse(p)

describe('序列', () => {
  it('参数里的顺序在前，新连入的按画布顺序排在后面；对白按顺序对应', () => {
    const inputs = {
      clips: [video('a'), video('b'), video('c')],
      dialogue: [audio('d1', '一'), audio('d2', '二')],
    }
    const arranged = arrangeSequence(
      params({
        clips: [{ source: 'c', in: 1 }, { source: 'gone' }, { source: 'a', dialogue: '' }],
      }),
      inputs,
    )
    expect(arranged.map((c) => c.source)).toEqual(['c', 'a', 'b'])
    expect(arranged[0]).toMatchObject({ in: 1, dialogue: { source: 'd1' } })
    expect(arranged[1]!.dialogue).toBeUndefined()
    expect(arranged[2]!.dialogue).toBeUndefined()
  })

  it('时间线：对白从所属镜头开头播放，字幕跟对白时长；配乐循环；出点不超过素材', () => {
    const p = params({ clips: [{ source: 'b', in: 0, out: 99, subtitle: '改过的字幕' }] })
    const arranged = arrangeSequence(p, {
      clips: [video('a'), video('b')],
      dialogue: [audio('d1', '一'), audio('d2', '二')],
    })
    // 顺序：b（参数里）在前，a 在后；d1 对应 b，d2 对应 a
    const spec = sequenceSpec(p, arranged, { clips: [4, 5], dialogue: [6, 2] }, [audio('m')])
    expect(spec).toMatchObject({ width: 1080, height: 1920, fps: 30 })
    expect(spec.clips.map((c) => [c.asset.assetId, c.in, c.out])).toEqual([
      ['v-b', 0, 4],
      ['v-a', 0, 5],
    ])
    // 第一段对白 6 秒，但第二段 4 秒处有自己的对白，截到 4 秒
    expect(spec.audio).toEqual([
      expect.objectContaining({
        asset: expect.objectContaining({ assetId: 'a-d1' }),
        start: 0,
        duration: 4,
      }),
      expect.objectContaining({
        asset: expect.objectContaining({ assetId: 'a-d2' }),
        start: 4,
        duration: 2,
      }),
      expect.objectContaining({ asset: expect.objectContaining({ assetId: 'a-m' }), loop: true }),
    ])
    expect(spec.subtitles).toEqual({
      style: 'standard',
      cues: [
        { start: 0, end: 4, text: '改过的字幕' },
        { start: 4, end: 6, text: '二' },
      ],
    })
  })

  it('关掉字幕时不生成字幕；时长为 0 的段跳过', () => {
    const p = params({ subtitles: false, clips: [{ source: 'a', in: 10 }] })
    const arranged = arrangeSequence(p, {
      clips: [video('a'), video('b')],
      dialogue: [audio('d', '一')],
    })
    const spec = sequenceSpec(p, arranged, { clips: [5, 5], dialogue: [1, undefined] }, undefined)
    expect(spec.clips.map((c) => c.asset.assetId)).toEqual(['v-b'])
    expect(spec.subtitles).toBeUndefined()
  })
})

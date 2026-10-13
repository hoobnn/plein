import type { PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import {
  arrangeSequence,
  dialogueCues,
  sequenceNode,
  sequenceSpec,
  sequenceTimeline,
} from './sequence'

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

  // 一个镜头里常有好几句台词：只播第一句的话，其余台词会悄悄从成片里消失
  it('同一镜头的多句台词依次播放，每句一条字幕和一条音轨', () => {
    const p = params({
      clips: [{ source: 'a', dialogue: 'd1', more: ['d2', 'd3'] }, { source: 'b' }],
    })
    const arranged = arrangeSequence(p, {
      clips: [video('a'), video('b')],
      dialogue: [audio('d1', '松手！'), audio('d2', '这是我的件！'), audio('d3', '那不是快递！')],
    })
    // 写进 more 的台词不参与按顺序对应：b 没有自己的对白
    expect(arranged[1]!.dialogue).toBeUndefined()
    const spec = sequenceSpec(
      p,
      arranged,
      { clips: [5, 5], dialogue: [1, undefined], more: [[1.5, 3], []] },
      undefined,
    )
    expect(spec.audio.map((a) => [a.asset.assetId, a.start, a.duration])).toEqual([
      ['a-d1', 0, 1],
      ['a-d2', 1.2, 1.5],
      // 第三句放到镜头结尾为止（b 没有对白，可以延续到成片结尾）
      ['a-d3', 2.9, 3],
    ])
    expect(spec.subtitles?.cues.map((c) => c.text)).toEqual([
      '松手！',
      '这是我的件！',
      '那不是快递！',
    ])
    const cues = spec.subtitles!.cues
    for (let i = 0; i + 1 < cues.length; i++)
      expect(cues[i]!.end).toBeLessThanOrEqual(cues[i + 1]!.start)
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

  it('叠化：相邻镜头重叠，后面的对白和字幕跟着提前；转场时长不超过最短镜头的一半', () => {
    const p = params({ transition: '叠化', transitionDuration: 2 })
    const arranged = arrangeSequence(p, {
      clips: [video('a'), video('b'), video('c')],
      dialogue: [audio('d1', '一'), audio('d2', '二'), audio('d3', '三')],
    })
    const tl = sequenceTimeline(p, arranged, { clips: [4, 3, 5], dialogue: [1, 1, 1] })
    expect(tl.transition).toEqual({ type: 'dissolve', duration: 1.5 })
    expect(tl.clips.map((c) => c.start)).toEqual([0, 2.5, 4])
    expect(tl.total).toBe(9)
    expect(tl.clips[2]!.cues).toEqual([{ start: 4, end: 5, text: '三' }])
    // 经黑场淡入淡出不改变时长
    const fade = sequenceTimeline(params({ transition: '淡入淡出' }), arranged, {
      clips: [4, 3, 5],
      dialogue: [1, 1, 1],
    })
    expect(fade.total).toBe(12)
    expect(fade.transition).toEqual({ type: 'fade', duration: 0.5 })
  })

  it('字幕按识别结果对齐：句数一致逐句对上，否则整段铺满说话的时间', () => {
    const segs = [
      { start: 0.2, end: 1.1, text: '你终于来了' },
      { start: 1.4, end: 2.6, text: '我等你很久了' },
    ]
    expect(dialogueCues('你终于来了。我等你很久了！', segs, 3)).toEqual([
      { start: 0.2, end: 1.1, text: '你终于来了。' },
      { start: 1.4, end: 2.6, text: '我等你很久了！' },
    ])
    expect(dialogueCues('你终于来了，我等你很久了', segs, 3)).toEqual([
      { start: 0.2, end: 2.6, text: '你终于来了，我等你很久了' },
    ])
    expect(dialogueCues('', segs, 3).map((c) => c.text)).toEqual(['你终于来了', '我等你很久了'])
    expect(dialogueCues('台词', undefined, 3)).toEqual([{ start: 0, end: 3, text: '台词' }])
  })
})

import type { PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import {
  arrangeSequence,
  DUCK_LEVEL,
  dialogueCues,
  duckEnvelope,
  sequenceNode,
  sequenceSpec,
  sequenceTimeline,
  createSubtitleTrack,
  subtitleExportProblem,
  subtitleTrackStale,
} from './sequence'
import { subtitleSrt } from './interchange'

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
  it('全部对白形成持久字幕轨；逐句编辑和隐藏同时供预览、MP4 与 SRT 使用', () => {
    const p = params({
      asrTiming: true,
      model: 'mock:asr',
      clips: [{ source: 'a', dialogue: 'd1', more: ['d2'] }],
    })
    const arranged = arrangeSequence(p, {
      clips: [video('a')],
      dialogue: [audio('d1', '一。二。'), audio('d2', '三。四。')],
    })
    const durations = { clips: [8], dialogue: [2], more: [[2]] }
    expect(subtitleExportProblem(p, arranged)).toContain('先')
    const segments = [
      { start: 0.1, end: 0.5, text: 'x' },
      { start: 1, end: 1.5, text: 'y' },
    ]
    const track = createSubtitleTrack(p, arranged, durations, {
      'a-d1': segments,
      'a-d2': segments,
    })
    expect(track.cues.map((q) => [q.start, q.text])).toEqual([
      [0.1, '一。'],
      [1, '二。'],
      [2.3, '三。'],
      [3.2, '四。'],
    ])
    track.cues[0] = { ...track.cues[0]!, text: '修订字幕', start: 0.25, end: 0.75 }
    track.cues[1]!.hidden = true
    const saved = params({ ...p, subtitleTrack: JSON.parse(JSON.stringify(track)) })
    const preview = sequenceTimeline(saved, arranged, durations).clips.flatMap((c) => c.cues)
    const output = sequenceSpec(saved, arranged, durations, undefined).subtitles!.cues
    expect(output).toEqual(preview)
    expect(output).toHaveLength(3)
    expect(subtitleSrt(output)).toContain('00:00:00,250 --> 00:00:00,750\n修订字幕')
    expect(subtitleExportProblem(saved, arranged)).toBeUndefined()
    expect(subtitleTrackStale({ ...saved, musicVolume: 0.5 }, arranged)).toBe(false)
    const changed = arranged.map((c) => ({ ...c, clip: { ...c.clip, assetId: 'new-audio' } }))
    expect(subtitleTrackStale(saved, changed)).toBe(true)
    expect(() => sequenceSpec(saved, changed, durations, undefined)).toThrow('字幕已过期')
  })

  it('隐藏全部字幕不恢复默认台词；非法时间需显式修正，关闭字幕允许无字幕导出', () => {
    const p = params()
    const arranged = arrangeSequence(p, { clips: [video('a')], dialogue: [audio('d1', '台词')] })
    const durations = { clips: [4], dialogue: [2] }
    const track = createSubtitleTrack(p, arranged, durations)
    track.cues[0]!.hidden = true
    const saved = params({ subtitleTrack: track })
    expect(sequenceSpec(saved, arranged, durations, undefined).subtitles).toBeUndefined()
    track.cues[0] = { ...track.cues[0]!, hidden: false, start: 3, end: 1 }
    expect(subtitleExportProblem(params({ subtitleTrack: track }), arranged)).toContain('结束时间')
    expect(
      subtitleExportProblem(params({ subtitles: false, subtitleTrack: track }), arranged),
    ).toBeUndefined()
  })
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

  it('别的段已经指定的对白不再按顺序自动对应：换顺序后同一句台词不会播两遍', () => {
    // a 原来在第一段、自动对应了 d1 并记了下来；拖到最后后 b 成了第一段
    const arranged = arrangeSequence(
      params({ clips: [{ source: 'b' }, { source: 'a', dialogue: 'd1' }] }),
      { clips: [video('a'), video('b')], dialogue: [audio('d1', '一')] },
    )
    expect(arranged.map((c) => [c.source, c.dialogue?.source])).toEqual([
      ['b', undefined],
      ['a', 'd1'],
    ])
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
    expect(tl.clips.map((c) => c.transition)).toEqual([
      undefined,
      { type: 'dissolve', duration: 1.5 },
      { type: 'dissolve', duration: 1.5 },
    ])
    expect(tl.clips.map((c) => c.start)).toEqual([0, 2.5, 4])
    expect(tl.total).toBe(9)
    expect(tl.clips[2]!.cues).toEqual([{ start: 4, end: 5, text: '三' }])
    // 经黑场淡入淡出不改变时长
    const fade = sequenceTimeline(params({ transition: '淡入淡出' }), arranged, {
      clips: [4, 3, 5],
      dialogue: [1, 1, 1],
    })
    expect(fade.total).toBe(12)
    expect(fade.clips[1]!.transition).toEqual({ type: 'fade', duration: 0.5 })
  })

  it('每段可以单独指定转场、速度、原声音量和台词延后', () => {
    const p = params({
      transition: '叠化',
      transitionDuration: 0.5,
      clips: [
        { source: 'a', speed: 2, volume: 0.5 },
        { source: 'b', transition: '无', lineDelay: 0.5 },
        { source: 'c', transition: '推移', transitionDuration: 1 },
      ],
    })
    const arranged = arrangeSequence(p, {
      clips: [video('a'), video('b'), video('c')],
      dialogue: [audio('d1'), audio('d2'), audio('d3')],
    })
    const durations = { clips: [4, 3, 5], dialogue: [1, 1, 1] }
    const tl = sequenceTimeline(p, arranged, durations)
    // a 两倍速只占 2 秒；b 硬切；c 推移 1 秒
    expect(tl.clips.map((c) => [c.start, c.length])).toEqual([
      [0, 2],
      [2, 3],
      [4, 5],
    ])
    expect(tl.clips[1]!.transition).toBeUndefined()
    expect(tl.clips[2]!.transition).toEqual({ type: 'slide', duration: 1 })
    expect(tl.clips[1]!.lines[0]!.start).toBe(2.5)
    const spec = sequenceSpec(p, arranged, durations, [audio('m')])
    expect(spec.clips[0]).toMatchObject({ in: 0, out: 4, speed: 2, volume: 0.5 })
    expect(spec.clips[2]!.transition).toEqual({ type: 'slide', duration: 1 })
    expect(spec.transition).toBeUndefined()
    expect(spec.loudnorm).toBe(true)
    // 对白时压低配乐：第二、三句只隔 0.5 秒，中间不回升，共两次起落
    const music = spec.audio.find((a) => a.loop)!
    // 第一句从 0 秒开始：一开始就是压低的，没有起始的 1
    expect(music.envelope?.length).toBe(7)
    expect(music.envelope?.[0]).toEqual([0, DUCK_LEVEL])
  })

  it('压低配乐：挨得近的两句之间不回升；关掉后没有包络', () => {
    const tl = {
      total: 10,
      clips: [
        {
          start: 0,
          length: 5,
          cues: [],
          lines: [
            { start: 1, duration: 1 },
            { start: 2.2, duration: 1 },
          ],
        },
      ],
    }
    expect(duckEnvelope(tl)).toEqual([
      [0.85, 1],
      [1, DUCK_LEVEL],
      [3.2, DUCK_LEVEL],
      [3.6, 1],
    ])
    const p = params({ duck: false })
    const arranged = arrangeSequence(p, { clips: [video('a')], dialogue: [audio('d')] })
    const spec = sequenceSpec(p, arranged, { clips: [3], dialogue: [1] }, [audio('m')])
    expect(spec.audio.find((a) => a.loop)!.envelope).toBeUndefined()
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

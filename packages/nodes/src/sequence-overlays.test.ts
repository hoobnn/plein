import type { CompositionSourceRef, PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import {
  arrangeSequence,
  createSubtitleTrack,
  SequenceOverlay,
  SequenceSubtitleCue,
  sequenceNode,
  sequenceOverlayProblem,
  sequenceOverlays,
  sequenceSpec,
  sequenceTimeline,
} from './sequence'

const video = (source: string): PortValue => ({
  type: 'video',
  kind: 'video',
  assetId: `v-${source}`,
  source,
})
const audio = (source: string): PortValue => ({
  type: 'audio',
  kind: 'audio',
  assetId: `a-${source}`,
  source,
  caption: '对白。',
})
const params = (value: Record<string, unknown> = {}) => sequenceNode.params.parse(value)
const defaults = { id: 'layer-1', source: 'overlay', duration: 5 }

describe('独立叠加轨', () => {
  it('缺省合同保留原序列行为；叠加输入独立于 clips', () => {
    const p = params()
    expect(p.overlays).toEqual([])
    expect(p.subtitleRender).toBe('static')
    expect(p.subtitleAnimation).toBe('pop')
    expect(sequenceNode.inputs.find((input) => input.id === 'overlays')).toMatchObject({
      type: 'video',
      multiple: true,
    })
    expect(SequenceOverlay.parse(defaults)).toEqual({
      ...defaults,
      start: 0,
      in: 0,
      speed: 1,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      opacity: 1,
      hidden: false,
    })
  })

  it('镜头重排后按已算的 start 锚定，按可见末尾截断，素材 trim/speed 不随背景再次变速', () => {
    const p = params({
      clips: [
        { source: 'a', speed: 2 },
        { source: 'b', in: 1, out: 5 },
      ],
      overlays: [{ ...defaults, clip: 'a', start: 1, in: 3, speed: 0.5, x: 0.25, width: 0.5 }],
    })
    const inputs = { clips: [video('a'), video('b')], overlays: [video('overlay')] }
    const arranged = arrangeSequence(p, inputs)
    const durations = { clips: [6, 6], dialogue: [] }
    const spec = sequenceSpec(
      p,
      arranged,
      durations,
      undefined,
      undefined,
      undefined,
      inputs.overlays,
    )
    expect(spec.overlays?.[0]).toMatchObject({
      start: 1,
      duration: 2,
      in: 3,
      speed: 0.5,
      x: 0.25,
      width: 0.5,
    })
    const reordered = params({ ...p, clips: [p.clips[1], p.clips[0]] })
    const reorderedClips = arrangeSequence(reordered, inputs)
    const after = sequenceSpec(
      reordered,
      reorderedClips,
      durations,
      undefined,
      undefined,
      undefined,
      inputs.overlays,
    )
    expect(after.overlays?.[0]).toMatchObject({ start: 5, duration: 2, in: 3, speed: 0.5 })
  })

  it('绝对轨截到成片结尾，数组顺序保留绘制顺序与每个素材的精确来源', () => {
    const source: CompositionSourceRef = {
      version: 1,
      bundleAssetId: 'a'.repeat(64),
      manifestAssetId: 'b'.repeat(64),
      dependencyAssetIds: ['c'.repeat(64)],
      rendererIdentity: 'test',
    }
    const p = params({ overlays: [defaults, { ...defaults, id: 'top', start: 2, duration: 10 }] })
    const arranged = arrangeSequence(p, { clips: [video('background')] })
    const input = { ...video('overlay'), compositionSource: source } as PortValue
    const output = sequenceOverlays(
      p,
      arranged,
      [input],
      sequenceTimeline(p, arranged, { clips: [4], dialogue: [] }),
    )
    expect(output.map((overlay) => [overlay.id, overlay.start, overlay.duration])).toEqual([
      ['layer-1', 0, 4],
      ['top', 2, 2],
    ])
    expect(output[0]?.asset.compositionSource).toEqual(source)
    expect(output[0]?.asset.kind).toBe('video')
  })

  it('断开的来源、缺失锚点、全部超界和重复标识明确失败；隐藏轨可保留修复', () => {
    const p = params({ overlays: [defaults] })
    const arranged = arrangeSequence(p, { clips: [video('background')] })
    const timeline = sequenceTimeline(p, arranged, { clips: [4], dialogue: [] })
    expect(sequenceOverlayProblem(p, arranged, undefined, timeline)).toContain('来源已断开')
    expect(() => sequenceOverlays(p, arranged, [], timeline)).toThrow('来源已断开')
    expect(
      sequenceOverlayProblem(
        params({ overlays: [{ ...defaults, clip: 'gone' }] }),
        arranged,
        [video('overlay')],
        timeline,
      ),
    ).toContain('锚定的镜头')
    expect(
      sequenceOverlayProblem(
        params({ overlays: [{ ...defaults, start: 4 }] }),
        arranged,
        [video('overlay')],
        timeline,
      ),
    ).toContain('起点已超出')
    expect(
      sequenceOverlayProblem(
        params({ overlays: [defaults, defaults] }),
        arranged,
        [video('overlay')],
        timeline,
      ),
    ).toContain('标识重复')
    const hidden = params({ overlays: [{ ...defaults, clip: 'gone', hidden: true }] })
    expect(sequenceOverlays(hidden, arranged, [], timeline)).toEqual([])
    expect(hidden.overlays).toHaveLength(1)
  })

  it.each([
    { start: Number.NaN },
    { duration: Infinity },
    { duration: 0 },
    { in: -1 },
    { speed: 0.1 },
    { x: -0.1 },
    { y: 1.1 },
    { width: 0 },
    { height: Infinity },
    { opacity: 1.1 },
  ])('时间与归一化位置不能是非法值 %j', (patch) => {
    expect(SequenceOverlay.safeParse({ ...defaults, ...patch }).success).toBe(false)
  })
})

describe('字幕渲染与来源合同', () => {
  it('有识别段才标 ASR，无识别段标 estimated，手工镜头字幕保持 manual', () => {
    const p = params({ clips: [{ source: 'a' }, { source: 'b', subtitle: '手工字幕' }] })
    const arranged = arrangeSequence(p, {
      clips: [video('a'), video('b')],
      dialogue: [audio('d1'), audio('d2')],
    })
    const durations = { clips: [4, 4], dialogue: [2, 2] }
    const segments = [{ start: 0.2, end: 1.5, text: '识别' }]
    expect(createSubtitleTrack(p, arranged, durations).cues.map((cue) => cue.origin)).toEqual([
      'estimated',
      'manual',
    ])
    expect(
      createSubtitleTrack(p, arranged, durations, { 'a-d1': segments, 'a-d2': segments }).cues.map(
        (cue) => cue.origin,
      ),
    ).toEqual(['asr', 'manual'])
    expect(createSubtitleTrack(p, arranged, durations, { 'a-d1': [] }).cues[0]?.origin).toBe(
      'estimated',
    )
  })

  it('旧轨读作 legacy，保存的 id/source/origin 原样传到 timeline 和输出 cue', () => {
    expect(
      SequenceSubtitleCue.parse({ id: 'old', source: 'a', start: 0, end: 1, text: '旧字幕' })
        .origin,
    ).toBe('legacy')
    const p = params()
    const arranged = arrangeSequence(p, { clips: [video('a')], dialogue: [audio('d')] })
    const track = createSubtitleTrack(p, arranged, { clips: [4], dialogue: [2] })
    track.cues[0] = { ...track.cues[0]!, origin: 'manual', text: '手改' }
    const saved = params({ subtitleTrack: track })
    expect(
      sequenceTimeline(saved, arranged, { clips: [4], dialogue: [2] }).clips[0]?.cues[0],
    ).toMatchObject({ id: track.cues[0]?.id, source: 'a', origin: 'manual', text: '手改' })
  })

  it('none 保留 sidecar cue，animated 显式动画；subtitles=false 完全关闭 cue', () => {
    const inputs = { clips: [video('a')], dialogue: [audio('d')] }
    const durations = { clips: [4], dialogue: [2] }
    const make = (patch: Record<string, unknown>) => {
      const p = params(patch)
      return sequenceSpec(p, arrangeSequence(p, inputs), durations, undefined)
    }
    expect(make({}).subtitles?.render).toBeUndefined()
    expect(make({ subtitleRender: 'none' }).subtitles).toMatchObject({
      render: 'none',
      cues: [expect.objectContaining({ text: '对白。', origin: 'estimated' })],
    })
    expect(make({ subtitleRender: 'animated' }).subtitles).toMatchObject({
      render: 'animated',
      animation: 'pop',
    })
    expect(make({ subtitleRender: 'animated', subtitles: false }).subtitles).toBeUndefined()
  })
})

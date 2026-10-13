import type { AssetRef, ComposeSpec } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { placeSequence, sequenceFcpxml, sequenceOtio, subtitleSrt } from './interchange'

const ref = (assetId: string, kind: 'video' | 'audio' = 'video'): AssetRef => ({ assetId, kind })
const media = (r: AssetRef) => ({
  path: `media/${r.assetId}.${r.kind === 'video' ? 'mp4' : 'wav'}`,
  name: r.assetId,
  duration: r.kind === 'video' ? 4 : 3,
  hasVideo: r.kind === 'video',
  hasAudio: true,
})

const spec: ComposeSpec = {
  width: 1080,
  height: 1920,
  fps: 30,
  name: '雨夜 & 归来',
  clips: [
    { asset: ref('a'), in: 0, out: 4, volume: 1 },
    { asset: ref('b'), in: 1, out: 3, volume: 0.5, transition: { type: 'dissolve', duration: 1 } },
    {
      asset: ref('c'),
      in: 0,
      out: 4,
      volume: 1,
      speed: 2,
      transition: { type: 'wipe', duration: 0.4 },
    },
  ],
  audio: [
    { asset: ref('line', 'audio'), start: 0.5, duration: 1.5, volume: 1 },
    { asset: ref('bgm', 'audio'), start: 0, volume: 0.35, loop: true, fadeOut: 2 },
  ],
  subtitles: { cues: [{ start: 0.5, end: 2, text: '你来了' }], style: 'standard' },
}

describe('剪辑工程导出', () => {
  it('转场两侧各让出一半，轨道总长和成片一致', () => {
    const { placed, total, sounds } = placeSequence(spec, media)
    // 4 + 2 - 1 + 2 - 0.4
    expect(total).toBeCloseTo(6.6)
    expect(placed.map((p) => [p.offset, p.duration])).toEqual([
      [0, 3.5],
      [3.5, 1.3],
      [4.8, 1.8],
    ])
    expect(placed[1]!.source).toBeCloseTo(1.5)
    expect(placed[2]!.source).toBeCloseTo(0.4)
    const end = placed.at(-1)!
    expect(end.offset + end.duration).toBeCloseTo(total)
    // 配乐 3 秒一段循环铺满 6.6 秒
    expect(sounds.filter((s) => s.role === 'music').map((s) => s.duration)).toEqual([3, 3, 0.6])
  })

  it('OTIO：画面轨、原声轨、对白和配乐轨，转场是标准叠化', () => {
    const otio = JSON.parse(sequenceOtio(spec, media))
    const tracks = otio.tracks.children
    expect(tracks.map((t: { name: string }) => t.name)).toEqual([
      '画面',
      '原声',
      '对白音效',
      '配乐',
    ])
    const video = tracks[0].children
    expect(video.map((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA)).toEqual([
      'Clip.2',
      'Transition.1',
      'Clip.2',
      'Transition.1',
      'Clip.2',
    ])
    expect(video[1].in_offset.value).toBe(15)
    expect(video[4].effects[0]).toMatchObject({ OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: 2 })
    expect(video[0].media_references.DEFAULT_MEDIA.target_url).toBe('media/a.mp4')
  })

  it('FCPXML：分数时间、转场、挂在画面上的声音，名字转义', () => {
    const x = sequenceFcpxml(spec, media)
    expect(x).toContain('<fcpxml version="1.10">')
    expect(x).toContain('duration="33/5s"')
    expect(x).toContain('<transition name="叠化" offset="3s" duration="1s">')
    expect(x).toContain('雨夜 &amp; 归来')
    expect(x).toContain('<timeMap>')
    expect(x.match(/lane="-2"/g)).toHaveLength(3)
  })

  it('SRT', () => {
    expect(subtitleSrt(spec.subtitles!.cues)).toBe('1\n00:00:00,500 --> 00:00:02,000\n你来了\n')
  })
})

import type { ComposeOverlay, ComposeSpec } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { placeSequence, sequenceFcpxml, sequenceOtio } from './interchange'

const overlay = (id: string, value: Partial<ComposeOverlay> = {}): ComposeOverlay => ({
  id,
  asset: { assetId: id, kind: 'video' },
  start: 1,
  duration: 2,
  in: 3,
  speed: 0.5,
  x: 0.25,
  y: 0.5,
  width: 0.5,
  height: 0.25,
  opacity: 0.6,
  ...value,
})
const spec: ComposeSpec = {
  width: 1920,
  height: 1080,
  fps: 30,
  clips: [
    { asset: { assetId: 'background', kind: 'video' }, in: 2, out: 12, speed: 2, volume: 0.5 },
  ],
  audio: [],
  overlays: [overlay('bottom'), overlay('top', { start: 2, duration: 10, speed: 1 })],
}
const lookup = (ref: { assetId: string }) => ({
  path: `media/${ref.assetId}.webm`,
  name: ref.assetId,
  duration: 20,
  width: 1280,
  height: 720,
  hasVideo: true,
  hasAudio: true,
})

describe('NLE 独立叠加轨', () => {
  it('保留 paint 顺序、overlay 入点和独立速度；成片长只由主镜头决定', () => {
    const placed = placeSequence(spec, lookup)
    expect(placed.total).toBe(5)
    expect(
      placed.overlays.map((item) => [item.id, item.start, item.duration, item.in, item.speed]),
    ).toEqual([
      ['bottom', 1, 2, 3, 0.5],
      ['top', 2, 3, 3, 1],
    ])
    expect(placed.sounds).toEqual([])
  })

  it('OTIO 独立 Video 轨保留 gap、source range、timewarp、geometry/opacity/order 元数据，不建叠加原声轨', () => {
    const otio = JSON.parse(sequenceOtio(spec, lookup))
    const tracks = otio.tracks.children
    expect(tracks.map((track: { name: string }) => track.name)).toEqual([
      '画面',
      '叠加 1: bottom',
      '叠加 2: top',
      '原声',
    ])
    expect(tracks[1].children[0].source_range.duration.value).toBe(30)
    const clip = tracks[1].children[1]
    expect(clip.source_range.start_time.value).toBe(90)
    expect(clip.source_range.duration.value).toBe(60)
    expect(clip.effects[0]).toMatchObject({ OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: 0.5 })
    expect(clip.metadata.plein.overlay).toMatchObject({
      id: 'bottom',
      order: 0,
      x: 0.25,
      y: 0.5,
      width: 0.5,
      height: 0.25,
      opacity: 0.6,
    })
    expect(tracks.filter((track: { kind: string }) => track.kind === 'Audio')).toHaveLength(1)
    expect(tracks[3].children[0].media_references.DEFAULT_MEDIA.target_url).toContain('background')
  })

  it('FCPXML connected clips 在无变速父容器上定位；独立 lane、源窗口、像素几何与透明度准确输出且禁用原声', () => {
    const xml = sequenceFcpxml(spec, lookup)
    expect(xml).toContain(
      '<clip name="画面与叠加" offset="0s" start="0s" duration="5s" format="r1">',
    )
    expect(xml).toContain('width="1280" height="720"')
    const clips = xml.match(/<asset-clip [^>]*lane="[12]"[\s\S]*?<\/asset-clip>/g)!
    expect(clips).toHaveLength(2)
    expect(clips[0]).toContain(
      'lane="1" offset="1s" name="bottom" start="3s" duration="2s" srcEnable="video"',
    )
    expect(clips[0]).toContain('<timept time="5s" value="4s" interp="linear"/>')
    expect(clips[0]).toContain('<adjust-transform position="0 -12.5" scale="0.75 0.375"/>')
    expect(clips[0]).toContain('<adjust-blend amount="0.6"/>')
    expect(clips[1]).toContain('lane="2" offset="2s" name="top" start="3s" duration="3s"')
    expect(clips.every((clip) => !clip.includes('adjust-volume'))).toBe(true)
    expect(xml.indexOf('</spine>')).toBeLessThan(xml.indexOf('lane="1"'))
  })
})

import { describe, expect, it } from 'vite-plus/test'
import { strFromU8, unzipSync } from 'fflate'
import { CaptionLayerParams } from '@plein/nodes'
import { captionSourceArchive, renderCaptionLayer } from './captions'
import { assertLocalMotionHtml } from './security'
const params = CaptionLayerParams.parse({
  width: 1280,
  height: 720,
  duration: 2,
  style: 'boxed',
  animation: 'pop',
  cues: [
    {
      id: 'c1',
      source: 'clip1',
      origin: 'estimated',
      start: 0.25,
      end: 1.75,
      text: 'fetch(1) / url(1) 中英字幕',
    },
  ],
})
describe('caption immutable offline source', () => {
  it('不依赖Chrome/FFmpeg即可冻结完整cues及中文字体，保留原始时间和来源', async () => {
    const zip = unzipSync(await captionSourceArchive(params))
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!))
    expect(manifest).toMatchObject({
      schema: 'plein.caption-source.v1',
      templateVersion: 1,
      params,
      dependencyAssetIds: [],
      durationFrames: 60,
    })
    expect(manifest.params.cues[0]).toEqual(params.cues[0])
    expect(Object.keys(zip).filter((path) => path.endsWith('.woff2')).length).toBeGreaterThan(100)
    expect(zip['licenses/noto-sans-sc.txt']).toBeDefined()
    expect(zip['licenses/gsap-notice.md']).toBeDefined()
    expect(zip['vendor/gsap.min.js']).toBeDefined()
    const html = strFromU8(zip['index.html']!)
    expect(() => assertLocalMotionHtml(html)).not.toThrow()
    expect(html).toContain('background:transparent')
    expect(html).toContain('data-start="0.26666666666666666"')
    expect(manifest.renderIdentity).toMatch(/^[a-f0-9]{64}$/)
  })
  it('已取消的工作不会启动浏览器或读取工具', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      renderCaptionLayer(params, '/unused', {
        signal: controller.signal,
        ffmpeg: '/unused',
        ffprobe: '/unused',
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

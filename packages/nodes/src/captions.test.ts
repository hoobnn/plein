import { describe, expect, it } from 'vite-plus/test'
import { CaptionLayerParams, captionDurationFrames, captionLayerHtml } from './captions'
const params = (patch: Record<string, unknown> = {}) =>
  CaptionLayerParams.parse({
    width: 1280,
    height: 720,
    duration: 2,
    cues: [
      {
        id: 'cue-1',
        source: 'clip-2',
        origin: 'manual',
        start: 0.3,
        end: 1.5,
        text: '真实字幕，不伪造逐词时间',
      },
    ],
    ...patch,
  })
describe('受控动画字幕合同', () => {
  it('保留手工/asr来源及原始cue时间，HTML只投影cue级动画', () => {
    const p = params(),
      html = captionLayerHtml(p)
    expect(p.cues[0]).toMatchObject({
      id: 'cue-1',
      source: 'clip-2',
      origin: 'manual',
      start: 0.3,
      end: 1.5,
    })
    expect(captionDurationFrames(p)).toBe(60)
    expect(html).toContain('background:transparent')
    expect(html).toContain('data-start="0.3" data-end="1.5"')
    expect(html).toContain("window.__timelines['plein-captions']=tl")
    expect(html).toContain('真实字幕，不伪造逐词时间')
    expect(html).not.toContain('<video')
    expect(html).not.toContain('<audio')
    expect(html).not.toContain('clip-2')
  })
  it.each(['standard', 'bold', 'boxed'])('支持样式 %s 且背景保持透明', (style) => {
    const html = captionLayerHtml(params({ style, animation: 'pop' }))
    expect(html).toContain('scale:0.92')
    expect(html).toContain('ease:"back.out(1.3)"')
    expect(html).toContain('background:transparent')
  })
  it('转义script/style等文案，不执行来源字段', () => {
    const html = captionLayerHtml(
      params({
        cues: [
          {
            source: '<script>fetch(1)</script>',
            start: 0,
            end: 1,
            text: '</span><script>fetch(1)</script> url(1)',
          },
        ],
      }),
    )
    expect(html).toContain('&lt;script&gt;fetch(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>fetch(1)')
  })
  it.each([
    { width: 1279 },
    { duration: 301 },
    { fps: 24 },
    { html: '<script/>' },
    { cues: [{ start: 0, end: 3, text: '越界' }] },
    { cues: [{ start: 0, end: 0.001, text: '不足一帧' }] },
    { cues: [{ start: 1, end: 0, text: '反向' }] },
    { cues: [{ start: 0, end: 1, text: 'x', origin: 'invented' }] },
    { cues: [{ start: 0, end: 1, text: 'x', words: [] }] },
  ])('拒绝非法时间/尺寸及额外执行字段 %j', (patch) => {
    expect(() => params(patch)).toThrow()
  })
  it('包内依赖路径禁止外网和越界', () => {
    for (const path of ['https://example.com/a.js', '../a.js', '/tmp/a.js', 'a/%2e%2e/b.js'])
      expect(() => captionLayerHtml(params(), { gsap: path })).toThrow('本地相对路径')
  })
})

import { describe, expect, it } from 'vite-plus/test'
import { MotionParams, motionHtml } from '@plein/nodes'
import { assertLocalMotionHtml } from './security'

describe('motion offline document contract', () => {
  it('keeps ordinary escaped title text outside execution-context scans', () => {
    const html = motionHtml(
      MotionParams.parse({
        title: 'fetch(https://example.com) / url(http://localhost)',
        subtitle: '@import https://example.com',
      }),
      { gsap: 'vendor/gsap.min.js', fontCss: 'fonts/noto-sans-sc.css' },
    )
    expect(() => assertLocalMotionHtml(html)).not.toThrow()
  })
  it.each([
    '<img src="https://example.com/image.png">',
    '<video src="/private/input.mp4">',
    '<img src="../secret.png">',
    '<img src="file:///private/input.png">',
    '<form action="http://localhost:8787/api/"></form>',
    '<a href="javascript:alert(1)">x</a>',
    '<video poster="//example.com/poster.png"></video>',
    '<img srcset="safe.png 1x, http://127.0.0.1/x 2x">',
    '<style>@import "theme.css";</style>',
    '<style>div{background:url(https://example.com/x)}</style>',
    '<div style="background:url(/private/input.png)"></div>',
    '<style>div{background:u\\72l(http://example.com/x)}</style>',
    '<script>fetch("media/input.mp4")</script>',
    '<script>window["fetch"]("https://example.com")</script>',
    '<script>f\\u0065tch("http://localhost")</script>',
    '<script>new WebSocket("ws://localhost")</script>',
    '<iframe srcdoc="&lt;script&gt;fetch(1)&lt;/script&gt;"></iframe>',
    '<img src="x.png" onerror="fetch(1)">',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
  ])('rejects executable resource context: %s', (html) => {
    expect(() => assertLocalMotionHtml(html)).toThrow()
  })
  it('accepts relative packaged styles, media and scripts', () => {
    expect(() =>
      assertLocalMotionHtml(
        '<link href="fonts/font.css" rel="stylesheet"><style>@font-face{src:url("fonts/font.woff2")}</style><video src="media/input.mp4"></video><script src="vendor/gsap.min.js"></script>',
      ),
    ).not.toThrow()
  })
})

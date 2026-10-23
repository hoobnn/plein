import { describe, expect, it } from 'vite-plus/test'
import { corePlugin } from './core'
import {
  applyMotionEdit,
  MOTION_FPS,
  MotionEditOperation,
  motionDurationFrames,
  motionEditable,
  motionHtml,
  motionNode,
  MotionParams,
  motionSize,
} from './motion'

const params = (patch: Record<string, unknown> = {}) => MotionParams.parse(patch)

describe('动态合成合同', () => {
  it('以本地任务和普通视频端口注册，参数可无输入创建', () => {
    expect(motionNode).toMatchObject({ type: 'plein/motion', version: 1, execution: 'job' })
    expect(corePlugin.nodes).toContain(motionNode)
    expect(corePlugin.manifest.contributes.nodes).toContain('plein/motion@1')
    expect(motionNode.inputs.map((p) => [p.id, p.required, p.multiple])).toEqual([
      ['image', undefined, undefined],
      ['video', undefined, undefined],
    ])
    expect(motionNode.outputs).toEqual([{ id: 'video', label: '合成视频', type: 'video' }])
    expect(params()).toMatchObject({ template: 'title', duration: 6, audio: 'mute', overrides: {} })
  })

  it('统一规格和完整根时长按 30 fps 量化，不把小数舍入到错误帧', () => {
    expect(motionSize(params())).toEqual({ width: 1080, height: 1920 })
    expect(motionSize(params({ aspectRatio: '16:9', resolution: '720p' }))).toEqual({
      width: 1280,
      height: 720,
    })
    const p = params({ duration: 32 / 30 })
    const html = motionHtml(p)
    const root = html.match(/<main[^>]+>/)![0]
    const seconds = Number(root.match(/data-duration="([^"]+)"/)![1])
    expect(motionDurationFrames(p)).toBe(32)
    expect(Math.round(seconds * MOTION_FPS)).toBe(32)
    expect(Math.ceil(seconds * MOTION_FPS)).toBe(32)
    expect(root).toContain('data-composition-id="plein-motion"')
    expect(html).toContain('gsap.timeline({paused:true})')
    expect(html).toContain("window.__timelines['plein-motion']=tl")
    for (const field of motionEditable) {
      expect(html).toContain(`id="${field.id}" data-hf-id="${field.id}"`)
    }
  })

  it('三类模板依赖本地路径，视频只使用统一 offset/rate 与显式声音策略', () => {
    const character = motionHtml(params({ template: 'character' }), {
      image: 'media/portrait.png',
      fontCss: 'fonts/noto.css',
    })
    expect(character).toContain('<img id="hf-media"')
    expect(character).toContain('src="media/portrait.png"')
    expect(character).toContain('<link rel="stylesheet" href="fonts/noto.css">')
    const input = { template: 'video-title', sourceIn: 1.2, speed: 1.5 }
    const muted = motionHtml(params(input), { video: 'media/input.mp4', gsap: 'vendor/gsap.js' })
    expect(muted).toContain(
      'data-playback-start="1.2" data-playback-rate="1.5" data-volume="0" muted',
    )
    expect(muted).not.toContain('data-media-start')
    expect(
      motionHtml(params({ ...input, audio: 'source' }), { video: 'media/input.mp4' }),
    ).toContain('data-volume="1"')
    expect(muted).not.toMatch(/(?:https?:|file:|data:|javascript:|\/\/cdn)/i)
  })

  it('所有动态文案被转义，不能关闭标签或注入脚本', () => {
    const attack = '</p><script>alert("x")</script><img src=x onerror=alert(1)>&\''
    const html = motionHtml(
      params({ title: attack, subtitle: attack, overrides: { 'hf-title.text': attack } }),
    )
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).toContain('&amp;&#39;')
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html.match(/<script/g)).toHaveLength(2)
  })

  it.each([
    'https://example.com/a.js',
    '//example.com/a.js',
    '/private/a.js',
    '../a.js',
    'media/../a.js',
    'media/%2e%2e/a.js',
    'file:///a.js',
    'a.js?x=1',
    'a\\b.js',
    'media//x.js',
  ])('拒绝非本地或越界依赖 %s', (path) => {
    expect(() => motionHtml(params(), { gsap: path })).toThrow('本地相对路径')
  })

  it.each([
    { 'hf-title.attr.onclick': 'alert(1)' },
    { 'hf-media.attr.src': 'https://example.com/x.png' },
    { 'hf-title.style.backgroundImage': 'url(https://example.com)' },
    { 'hf-title.style.color': 'red;display:none' },
    { 'hf-title.style.fontSize': 'calc(100vw)' },
    { 'hf-media.text': '<script>' },
    { 'hf-root.text': 'replace root' },
    { 'hf-title': null },
    { 'hf-title.timing.start': -1 },
    { 'hf-title.timing.end': 31 },
    { 'hf-title.style.opacity': '2' },
  ])('拒绝未授权 SDK 覆盖 %j', (overrides) => {
    expect(MotionParams.safeParse({ overrides }).success).toBe(false)
  })

  it('结构化操作验证、应用并保留其余字段，文本/样式/时间使用原生SDK键', () => {
    const original = params({ title: 'base', overrides: { 'hf-subtitle.style.color': '#123456' } })
    const edited = applyMotionEdit(original, { op: 'text', id: 'hf-title', text: '修改标题' })
    const styled = applyMotionEdit(edited, {
      op: 'style',
      id: 'hf-title',
      property: 'fontSize',
      value: '80px',
    })
    const timed = applyMotionEdit(styled, { op: 'timing', id: 'hf-title', start: 1.01, end: 4.02 })
    expect(original.overrides).toEqual({ 'hf-subtitle.style.color': '#123456' })
    expect(timed.overrides).toEqual({
      'hf-subtitle.style.color': '#123456',
      'hf-title.text': '修改标题',
      'hf-title.style.fontSize': '80px',
      'hf-title.timing.start': 1,
      'hf-title.timing.end': 4 + 1 / 30,
    })
    const html = motionHtml(timed)
    expect(html).toContain('>修改标题</h1>')
    expect(html).toContain('font-size:80px')
    expect(html).toContain('data-start="1" data-end="4.033333333333333"')
    expect(
      MotionEditOperation.safeParse({ op: 'text', id: 'hf-title', text: 'x', script: 'evil' })
        .success,
    ).toBe(false)
    expect(() =>
      applyMotionEdit(original, {
        op: 'style',
        id: 'hf-media',
        property: 'fontSize',
        value: '80px',
      }),
    ).toThrow()
  })

  it('拒绝反转、超长和不足一帧的显示窗口，缩短片段不静默夹紧旧编辑', () => {
    for (const [start, end] of [
      [2, 1],
      [1, 7],
      [1, 1.001],
    ]) {
      expect(
        MotionParams.safeParse({
          overrides: { 'hf-title.timing.start': start, 'hf-title.timing.end': end },
        }).success,
      ).toBe(false)
    }
    const edited = applyMotionEdit(params(), { op: 'timing', id: 'hf-title', start: 1, end: 5 })
    expect(MotionParams.safeParse({ ...edited, duration: 3 }).success).toBe(false)
  })
})

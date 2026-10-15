import { describe, expect, it } from 'vite-plus/test'
import {
  applyShotLines,
  composeShotLines,
  pickShotPresets,
  presetsFor,
  shotConflicts,
  shotLinesIntact,
  shotPresets,
  shotStateOf,
} from './index'

const video = 'video.generate'
const pick = (
  prompt: string,
  change: Parameters<typeof pickShotPresets>[0]['change'],
  state = shotStateOf(undefined),
) => pickShotPresets({ prompt, state, change, presets: shotPresets, capability: video })

describe('镜头与风格预设', () => {
  it('拼成镜头一行、风格一行；速度只加在会动的运镜上', () => {
    const lines = composeShotLines(
      {
        picks: {
          'camera.move': 'plein/cam-push',
          'camera.shot': 'plein/shot-medium',
          'camera.light': 'plein/light-back',
          style: 'plein/style-film',
        },
        speed: 'slow',
      },
      shotPresets,
      video,
    )
    expect(lines).toEqual({
      camera: '镜头：缓慢推近主体，中景，膝盖以上，逆光，轮廓光。',
      style: '风格：胶片质感，细腻颗粒，暖色调。',
    })
    const still = composeShotLines(
      { picks: { 'camera.move': 'plein/cam-static' }, speed: 'fast' },
      shotPresets,
      video,
    )
    expect(still.camera).toBe('镜头：固定机位，镜头不动。')
    // 图片没有运镜，开头写「画面」
    expect(
      composeShotLines(
        { picks: { 'camera.move': 'plein/cam-push', 'camera.shot': 'plein/shot-full' } },
        shotPresets,
        'image.generate',
      ),
    ).toEqual({ camera: '画面：全景，人物全身入画。' })
  })

  it('换选项只替换自己那行，清空时连换行一起删；用户写的内容不动', () => {
    const a = pick('女孩站在雨里', { picks: { 'camera.move': 'plein/cam-push' } })
    expect(a.prompt).toBe('女孩站在雨里\n镜头：推近主体。')
    const b = pick(
      a.prompt,
      { picks: { 'camera.move': 'plein/cam-orbit' }, speed: 'slow' },
      a.state,
    )
    expect(b.prompt).toBe('女孩站在雨里\n镜头：缓慢环绕主体。')
    const c = pick(b.prompt, { picks: { style: 'plein/style-noir' } }, b.state)
    expect(c.prompt).toBe(
      '女孩站在雨里\n镜头：缓慢环绕主体。\n风格：黑色电影，高反差黑白，硬光阴影。',
    )
    const d = pick(c.prompt, { picks: { 'camera.move': null } }, c.state)
    expect(d.prompt).toBe('女孩站在雨里\n风格：黑色电影，高反差黑白，硬光阴影。')
  })

  it('那一行被手改过就不再替换，新行接到末尾', () => {
    const a = pick('海边', { picks: { 'camera.shot': 'plein/shot-long' } })
    const edited = a.prompt.replace('远景', '远景，海鸥飞过')
    expect(shotLinesIntact(edited, a.state.lines).camera).toBe(false)
    const b = pick(edited, { picks: { 'camera.shot': 'plein/shot-full' } }, a.state)
    expect(b.prompt).toBe(`${edited}\n镜头：全景，人物全身入画。`)
    expect(applyShotLines('x', {}, {})).toBe('x')
  })

  it('明显冲突：固定机位却写了运镜、图片里写运镜、风格预设和 @风格卡同用', () => {
    const a = pick('镜头推近她的脸', { picks: { 'camera.move': 'plein/cam-static' } })
    expect(
      shotConflicts({ prompt: a.prompt, state: a.state, capability: video, styleCard: false }),
    ).toEqual(['提示词里另写了运镜，和「固定机位」冲突'])
    const b = pick('固定机位拍她', {
      picks: { 'camera.move': 'plein/cam-push', style: 'plein/style-hk' },
    })
    expect(
      shotConflicts({ prompt: b.prompt, state: b.state, capability: video, styleCard: true }),
    ).toHaveLength(2)
    expect(
      shotConflicts({
        prompt: '镜头环绕她',
        state: shotStateOf(undefined),
        capability: 'image.generate',
        styleCard: false,
      }),
    ).toEqual(['图片不会动，运镜描述最多被当成构图参考'])
    // 自己插进去的那行不算冲突
    const c = pick('她回头', { picks: { 'camera.move': 'plein/cam-orbit' } })
    expect(
      shotConflicts({ prompt: c.prompt, state: c.state, capability: video, styleCard: false }),
    ).toEqual([])
  })

  it('镜头条的选项不出现在行首 / 预设菜单里', () => {
    expect(presetsFor(shotPresets, { type: 'plein/video', capability: video })).toEqual([])
  })
})

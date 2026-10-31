import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { fontFamilies, setSubtitleFont, subtitleFont } from './fonts'

/** 本机随便一个字体文件（fontconfig 给的默认无衬线体）；没有 fontconfig 时跳过 */
let anyFont = ''
try {
  anyFont = execFileSync('fc-match', ['-f', '%{file}', 'sans'], { encoding: 'utf8' }).trim()
} catch {}

describe.skipIf(!/\.(otf|ttf|ttc)$/i.test(anyFont))('字幕字体', () => {
  afterEach(() => setSubtitleFont(undefined))

  it('从 name 表读出字体族名', async () => {
    const families = await fontFamilies(anyFont)
    expect(families.length).toBeGreaterThan(0)
    expect(families[0]).toMatch(/\S/)
  })

  it('PLEIN_SUBTITLE_FONT 指定的文件优先；文件不存在时继续往下找', async () => {
    setSubtitleFont(anyFont)
    const font = await subtitleFont()
    // 族名与实现同规则：多语言合集（如 PingFang.ttc / NotoSansCJK.ttc）里优先 SC 那一款，
    // 否则取第一个族名。不断言 families[0]，避免依赖本机字体族顺序。
    const families = await fontFamilies(anyFont)
    expect(font).toMatchObject({
      file: anyFont,
      family: families.find((f) => /\bSC\b/.test(f)) ?? families[0],
    })
    setSubtitleFont('/no/such/font.otf')
    const fallback = await subtitleFont()
    expect(fallback?.file).not.toBe('/no/such/font.otf')
  })

  it('不是字体的文件读不出族名', async () => {
    await expect(fontFamilies(import.meta.filename)).rejects.toThrow()
  })
})

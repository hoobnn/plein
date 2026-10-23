import { CharacterProfile } from '@plein/nodes'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { freeName } from './freeName'

const withPeriods = (...names: string[]) =>
  CharacterProfile.parse({ periods: names.map((name, i) => ({ id: `p${i}`, name })) })

const graphemes = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text))

describe('档案自动命名', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('名称未被占用时原样返回', () => {
    expect(freeName(withPeriods('少年'), '青年')).toBe('青年')
  })

  it.each([
    ['ABCDEFGHIJKLMNOPQRST', 'ABCDEFGHIJKLMNOPQRS2'],
    ['😀'.repeat(10), `${'😀'.repeat(9)}2`],
    ['👩‍🚀'.repeat(4), `${'👩‍🚀'.repeat(3)}2`],
    ['é'.repeat(10), `${'é'.repeat(9)}2`],
  ])('满长档案名 %s 重复时按字形截断再加序号', (base, expected) => {
    const next = freeName(withPeriods(base), base)
    expect(next).toBe(expected)
    expect(next.length).toBeLessThanOrEqual(20)
    // 截断不切断字形簇：去掉序号后的前缀仍是原名完整字形的前缀。
    const stem = graphemes(next.slice(0, -1)).map((part) => part.segment)
    expect(stem).toEqual(
      graphemes(base)
        .slice(0, stem.length)
        .map((part) => part.segment),
    )
    // 加了序号的结果仍能通过档案校验保存。
    expect(() => withPeriods(base, next)).not.toThrow()
  })

  it('序号变成两位时继续截断以不超过上限', () => {
    const base = 'ABCDEFGHIJKLMNOPQRST'
    const taken = Array.from({ length: 8 }, (_, i) => `ABCDEFGHIJKLMNOPQRS${i + 2}`)
    const profile = CharacterProfile.parse({ periods: [{ id: 'p', name: base, aliases: taken }] })
    expect(freeName(profile, base)).toBe('ABCDEFGHIJKLMNOPQR10')
  })

  it('大量名称和旧名占用时跳过它们找到空闲序号，且不依赖时间戳', () => {
    const profile = CharacterProfile.parse({
      periods: [
        {
          id: 'period',
          name: '开心',
          aliases: Array.from({ length: 8 }, (_, i) => `开心${100 + i}`),
        },
      ],
      expressions: Array.from({ length: 11 }, (_, i) => ({
        id: `expression-${i}`,
        name: `开心${i * 9 + 1}`,
        aliases: Array.from({ length: 8 }, (_, j) => `开心${i * 9 + j + 2}`),
      })),
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T00:00:00.001Z'))
    expect(freeName(profile, '开心')).toBe('开心108')
    vi.setSystemTime(new Date('2030-01-01T12:34:56.789Z'))
    expect(freeName(profile, '开心')).toBe('开心108')
  })
})

import { describe, expect, it } from 'vite-plus/test'
import { relativeTime, stampTime } from './format'

describe('relativeTime', () => {
  const now = new Date(2026, 10, 7, 12, 0, 0).getTime()
  it('一分钟内统一写「刚刚」，不出现「48秒钟前」', () => {
    expect(relativeTime(now - 3_000, now)).toBe('刚刚')
    expect(relativeTime(now - 48_000, now)).toBe('刚刚')
  })
  it('一分钟起按分钟、小时、天写', () => {
    expect(relativeTime(now - 60_000, now)).toBe('1分钟前')
    expect(relativeTime(now - 5 * 3600_000, now)).toBe('5小时前')
    expect(relativeTime(now - 3 * 86400_000, now)).toBe('3天前')
  })
})

describe('stampTime', () => {
  it('月、日、时分秒补零', () => {
    expect(stampTime(new Date(2026, 10, 7, 4, 5, 6).getTime())).toBe('2026/11/07 04:05:06')
  })
})

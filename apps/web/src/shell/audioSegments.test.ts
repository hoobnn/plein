import { describe, expect, it } from 'vite-plus/test'
import { audioSplitPlan } from './audioSegments'

describe('音频切分计划', () => {
  it('自定义切点保留精确时间，区间允许留空与复用', () => {
    expect(audioSplitPlan(10, 'cuts', '1.25, 0:04.5')).toEqual([
      { start: 0, end: 1.25 },
      { start: 1.25, end: 4.5 },
      { start: 4.5, end: 10 },
    ])
    expect(audioSplitPlan(10, 'ranges', '0 - 1.25\n4.5 - 8\n0 - 1')).toEqual([
      { start: 0, end: 1.25 },
      { start: 4.5, end: 8 },
      { start: 0, end: 1 },
    ])
  })
  it('未知时长、倒挂、出界与过多分段均不提交', () => {
    for (const [duration, mode, value] of [
      [undefined, 'cuts', '1'],
      [3, 'cuts', '2, 1'],
      [3, 'cuts', '3'],
      [3, 'ranges', '0-1\n2-4'],
      [3, 'ranges', '1-0\n1-2'],
      [30, 'cuts', Array.from({ length: 20 }, (_, i) => i + 1).join(',')],
    ] as const)
      expect(() => audioSplitPlan(duration, mode, value)).toThrow()
    expect(audioSplitPlan(10, 'even', '', 20)).toHaveLength(20)
  })
})

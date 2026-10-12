import { describe, expect, it } from 'vitest'
import { type VideoMode, videoModeProblem } from './core'

describe('视频模式与连入图片数', () => {
  // 每行：模式，0–3 张图时能否运行
  it.each<[VideoMode, boolean[]]>([
    ['text', [true, true, true, true]],
    ['image', [false, true, false, false]],
    ['frames', [false, false, true, false]],
    ['reference', [false, true, true, true]],
  ])('%s', (mode, ok) => {
    expect([0, 1, 2, 3].map((n) => videoModeProblem(mode, n) === null)).toEqual(ok)
  })
})

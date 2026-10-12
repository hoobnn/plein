import { describe, expect, it } from 'vitest'
import { ratioOf, sizeByArea, sizeByLongEdge, tierEdge } from './size'

describe('尺寸换算', () => {
  it('画幅转宽高比，无法识别时按 1:1', () => {
    expect(ratioOf('16:9')).toBeCloseTo(16 / 9)
    expect(ratioOf('2.35:1')).toBe(2.35)
    for (const bad of [undefined, '', 'auto', '16x9', '16:', '-1:2']) expect(ratioOf(bad)).toBe(1)
  })

  it('按总像素换算时向下取到 step 的倍数，不超过总像素', () => {
    const pixels = 2048 * 2048
    expect(sizeByArea('16:9', pixels)).toEqual({ width: 2720, height: 1536 })
    expect(sizeByArea('9:16', pixels)).toEqual({ width: 1536, height: 2720 })
    const { width, height } = sizeByArea('16:9', pixels)
    expect(width * height).toBeLessThanOrEqual(pixels)
    expect(sizeByArea('3:2', 1_000_000, 64)).toEqual({ width: 1216, height: 768 })
  })

  it('无法识别的画幅按正方形换算', () => {
    expect(sizeByArea('auto', 1_000_000)).toEqual({ width: 992, height: 992 })
    expect(sizeByLongEdge(undefined, 1024)).toEqual({ width: 1024, height: 1024 })
  })

  it('按长边换算：横幅定宽、竖幅定高，短边向下取整到 step', () => {
    expect(sizeByLongEdge('16:9', 2048)).toEqual({ width: 2048, height: 1152 })
    expect(sizeByLongEdge('9:16', 2048)).toEqual({ width: 1152, height: 2048 })
    expect(sizeByLongEdge('4:3', 1000)).toEqual({ width: 1000, height: 744 })
    expect(sizeByLongEdge('3:4', 1000, 16)).toEqual({ width: 736, height: 1000 })
  })

  it('K 档位换成边长，格式不对时为 undefined', () => {
    expect(tierEdge('2K')).toBe(2048)
    expect(tierEdge('1.5k')).toBe(1536)
    expect(tierEdge('0.5K')).toBe(512)
    for (const bad of ['2048', 'K', '2KB', '2 K', '']) expect(tierEdge(bad)).toBeUndefined()
  })
})

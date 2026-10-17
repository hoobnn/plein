import { describe, expect, it } from 'vite-plus/test'
import { visibleRects } from './occlusion'

describe('DOM 内容遮挡', () => {
  const bounds = { x: 10, y: 20, w: 100, h: 80 }
  const area = (parts: ReturnType<typeof visibleRects>) => parts.reduce((n, r) => n + r.w * r.h, 0)
  it('保留无遮挡和仅贴边的内容', () => {
    expect(visibleRects(bounds, [{ x: 110, y: 20, w: 10, h: 80 }])).toEqual([bounds])
  })
  it('局部遮挡只扣除交集，完整遮挡没有可见区域', () => {
    const parts = visibleRects(bounds, [{ x: 30, y: 40, w: 20, h: 20 }])
    expect(parts).toHaveLength(4)
    expect(area(parts)).toBe(7600)
    expect(visibleRects(bounds, [bounds])).toEqual([])
  })
  it('多个遮挡重叠时不重新露出下层文字', () => {
    const covers = [
      { x: 10, y: 20, w: 70, h: 80 },
      { x: 50, y: 20, w: 60, h: 80 },
    ]
    expect(visibleRects(bounds, covers)).toEqual([])
    expect(visibleRects(bounds, [...covers, ...covers])).toEqual([])
  })
})

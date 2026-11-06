import { describe, expect, it } from 'vite-plus/test'
import { createElement, groupShots, shotGroupOf } from './index'
import { GRID_GAP, GRID_TILE_SIDE, gridPlan, placeGrid } from './grid'
import { openDoc } from './testing'

/** 切分规则切出共用函数之前浏览器端 splitGrid 内联的算法，逐字保留，用来锁住两端行为不变 */
function legacy(width: number, height: number, rows: number, cols: number) {
  const xs = Array.from({ length: cols + 1 }, (_, c) => Math.floor((c * width) / cols))
  const ys = Array.from({ length: rows + 1 }, (_, r) => Math.floor((r * height) / rows))
  const k = GRID_TILE_SIDE / Math.max(Math.ceil(width / cols), Math.ceil(height / rows))
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, Math.round((xs[c + 1]! - xs[c]!) * k)),
  )
  const heights = Array.from({ length: rows }, (_, r) =>
    Math.max(1, Math.round((ys[r + 1]! - ys[r]!) * k)),
  )
  const out = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({
        left: xs[c]!,
        top: ys[r]!,
        width: xs[c + 1]! - xs[c]!,
        height: ys[r + 1]! - ys[r]!,
        w: widths[c]!,
        h: heights[r]!,
        x: widths.slice(0, c).reduce((sum, w) => sum + w, 0) + c * GRID_GAP,
        y: heights.slice(0, r).reduce((sum, h) => sum + h, 0) + r * GRID_GAP,
      })
  return out
}

describe('gridPlan', () => {
  it('分界与布局和原浏览器端算法逐格一致', () => {
    const sizes: Array<[number, number]> = [
      [5, 3],
      [1024, 1024],
      [1365, 768],
      [1000, 1001],
      [8, 8],
    ]
    const layouts: Array<[number, number]> = [
      [2, 2],
      [3, 3],
      [1, 4],
      [4, 1],
      [2, 3],
    ]
    for (const [w, h] of sizes)
      for (const [rows, cols] of layouts) {
        if (w < cols || h < rows) continue
        const plan = gridPlan(w, h, rows, cols)
        expect(
          plan.tiles.map(({ left, top, width, height, w, h, x, y }) => ({
            left,
            top,
            width,
            height,
            w,
            h,
            x,
            y,
          })),
        ).toEqual(legacy(w, h, rows, cols))
      }
  })

  it('覆盖全部像素，余数归入后续格子', () => {
    const plan = gridPlan(5, 3, 2, 2)
    expect(plan.tiles.map((t) => [t.left, t.top, t.width, t.height])).toEqual([
      [0, 0, 2, 1],
      [2, 0, 3, 1],
      [0, 1, 2, 2],
      [2, 1, 3, 2],
    ])
    const area = plan.tiles.reduce((sum, t) => sum + t.width * t.height, 0)
    expect(area).toBe(15)
  })

  it('图片比行列数还小时报错', () => {
    expect(() => gridPlan(2, 9, 3, 3)).toThrow('至少 3×3')
  })
})

describe('placeGrid', () => {
  it('切片按格子排在源元素右侧并成为记录原图的分镜组', () => {
    const doc = openDoc()
    const source = createElement(doc, { kind: 'image', assetId: 's', x: 0, y: 0, w: 320, h: 192 })
    const plan = gridPlan(1024, 1024, 2, 2)
    const { frame, elements } = placeGrid(doc, source, plan, ['a', 'b', 'c', 'd'])
    expect(elements).toHaveLength(4)
    expect(groupShots(doc, frame!).map((e) => e.assetId)).toEqual(['a', 'b', 'c', 'd'])
    expect(shotGroupOf(doc.get(frame!)!)?.source).toEqual({ elementId: source, rows: 2, cols: 2 })
    expect(doc.get(frame!)!.x).toBeGreaterThanOrEqual(320)
  })
})

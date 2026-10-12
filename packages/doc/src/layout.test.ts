import { describe, expect, it } from 'vitest'
import {
  arrangeElements,
  connect,
  createElement,
  groupElements,
  type LayoutItem,
  layoutGraph,
  type Rect,
} from './index'
import { node, openDoc as open, overlaps } from './testing'

const item = (id: string, x = 0, y = 0, w = 100, h = 80): LayoutItem => ({ id, x, y, w, h })

function expectNoOverlap(rects: Rect[]) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(overlaps(rects[i]!, rects[j]!), `${i} 与 ${j} 重叠`).toBe(false)
    }
  }
}

const placed = (items: LayoutItem[], pos: Map<string, { x: number; y: number }>) =>
  items.map((it) => ({ ...it, ...pos.get(it.id)! }))

describe('layoutGraph', () => {
  it('上游在左、下游在右，同层纵向排开', () => {
    const items = [item('a', 500, 500), item('b', 0, 0), item('c', 0, 300), item('d', 900, 0)]
    // a → b, a → c, b → d, c → d
    const pos = layoutGraph(items, [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'd'],
      ['c', 'd'],
    ])
    const x = (id: string) => pos.get(id)!.x
    expect(x('a')).toBe(0)
    expect(x('b')).toBe(x('c'))
    expect(x('b')).toBeGreaterThan(x('a') + 100)
    expect(x('d')).toBeGreaterThan(x('b') + 100)
    // 同层按原位置先上后下
    expect(pos.get('b')!.y).toBeLessThan(pos.get('c')!.y)
    expectNoOverlap(placed(items, pos))
  })

  it('跨层连线按最长路径分层', () => {
    const items = ['a', 'b', 'c'].map((id) => item(id))
    const pos = layoutGraph(items, [
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
    ])
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x)
    expect(pos.get('b')!.x).toBeLessThan(pos.get('c')!.x)
  })

  it('源头紧挨下游，不被拉到最左层', () => {
    const items = ['a', 'b', 'c', 's'].map((id) => item(id))
    const pos = layoutGraph(items, [
      ['a', 'b'],
      ['b', 'c'],
      ['s', 'c'],
    ])
    expect(pos.get('s')!.x).toBe(pos.get('b')!.x)
  })

  it('连线成环也能完成，且不重叠', () => {
    const items = ['a', 'b', 'c'].map((id, i) => item(id, i * 10, 0))
    const pos = layoutGraph(items, [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ])
    expect(new Set(items.map((it) => pos.get(it.id)!.x)).size).toBe(3)
    expectNoOverlap(placed(items, pos))
  })

  it('孤立元素按阅读顺序排在连线组下方，超宽换行', () => {
    const items = [
      item('a'),
      item('b'),
      ...Array.from({ length: 8 }, (_, i) => item(`s${i}`, i * 50, 1000, 300, 200)),
    ]
    const pos = layoutGraph(items, [['a', 'b']], { rowWidth: 1000 })
    const s = (i: number) => pos.get(`s${i}`)!
    expect(s(0).y).toBeGreaterThan(pos.get('a')!.y + 80)
    expect(s(0).x).toBe(0)
    expect(s(1).x).toBeGreaterThan(s(0).x)
    expect(s(3).y).toBeGreaterThan(s(0).y)
    expectNoOverlap(placed(items, pos))
  })

  it('随机图不重叠，包围盒左上角在原点', () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    for (let round = 0; round < 20; round++) {
      const n = 3 + Math.floor(rand() * 25)
      const items = Array.from({ length: n }, (_, i) =>
        item(`n${i}`, rand() * 2000, rand() * 2000, 60 + rand() * 400, 40 + rand() * 400),
      )
      const links: Array<[string, string]> = []
      for (let k = 0; k < n * 1.2; k++) {
        links.push([`n${Math.floor(rand() * n)}`, `n${Math.floor(rand() * n)}`])
      }
      const pos = layoutGraph(items, links)
      const rects = placed(items, pos)
      expectNoOverlap(rects)
      expect(Math.min(...rects.map((r) => r.x))).toBe(0)
      expect(Math.min(...rects.map((r) => r.y))).toBe(0)
    }
  })
})

describe('arrangeElements', () => {
  it('整理整个画布，锚定原包围盒左上角，是一个撤销步', () => {
    const doc = open()
    const a = createElement(doc, node({ x: 400, y: 300 }))
    const b = createElement(doc, node({ x: 200, y: 600 }))
    connect(doc, [a, 'out'], [b, 'in'])
    doc.undo.stopCapturing()
    expect(arrangeElements(doc)).toBeGreaterThan(0)
    expect(doc.get(a)!.x).toBe(200)
    expect(doc.get(b)!.x).toBeGreaterThan(doc.get(a)!.x + 100)
    expect(Math.min(doc.get(a)!.y, doc.get(b)!.y)).toBe(300)
    doc.undo.undo()
    expect(doc.get(a)).toMatchObject({ x: 400, y: 300 })
    expect(doc.get(b)).toMatchObject({ x: 200, y: 600 })
    // 已经整理过时不再产生撤销步
    doc.undo.redo()
    expect(arrangeElements(doc)).toBe(0)
  })

  it('Frame 内的元素在 Frame 内整理，Frame 收放到内容大小；跨组连线投影到 Frame', () => {
    const doc = open()
    const a = createElement(doc, node({ x: 0, y: 0 }))
    const b = createElement(doc, node({ x: 50, y: 50 }))
    connect(doc, [a, 'out'], [b, 'in'])
    const frame = groupElements(doc, [a, b])!
    const outside = createElement(doc, node({ x: -900, y: 0 }))
    connect(doc, [b, 'out'], [outside, 'in'])
    arrangeElements(doc)

    const f = doc.get(frame)!
    const ra = doc.worldRect(a)!
    const rb = doc.worldRect(b)!
    expect(rb.x).toBeGreaterThan(ra.x + ra.w)
    for (const r of [ra, rb]) {
      expect(r.x).toBeGreaterThanOrEqual(f.x)
      expect(r.y).toBeGreaterThanOrEqual(f.y)
      expect(r.x + r.w).toBeLessThanOrEqual(f.x + f.w)
      expect(r.y + r.h).toBeLessThanOrEqual(f.y + f.h)
    }
    // 下游在 Frame 外：Frame 整体在它左边
    expect(doc.get(outside)!.x).toBeGreaterThan(f.x + f.w)
    expectNoOverlap([doc.worldRect(frame)!, doc.worldRect(outside)!])
  })

  it('只整理所选，锁定的元素不动', () => {
    const doc = open()
    const a = createElement(doc, node({ x: 0, y: 0 }))
    const b = createElement(doc, node({ x: 0, y: 0 }))
    const c = createElement(doc, node({ x: 0, y: 0, locked: true }))
    const d = createElement(doc, node({ x: 5, y: 5 }))
    arrangeElements(doc, [a, b, c])
    expect(doc.get(c)).toMatchObject({ x: 0, y: 0 })
    expect(doc.get(d)).toMatchObject({ x: 5, y: 5 })
    expectNoOverlap([doc.get(a)!, doc.get(b)!])
  })
})

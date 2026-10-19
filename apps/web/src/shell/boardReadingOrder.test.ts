import { expect, it } from 'vite-plus/test'
import { boardReadingOrder } from './boardReadingOrder'

it('相邻位置形成循环比较时，六种输入排列得到相同阅读顺序', () => {
  const items = [
    { id: 'A', x: 0, y: 120 },
    { id: 'B', x: 100, y: 60 },
    { id: 'C', x: 200, y: 0 },
  ]
  for (const order of [
    [0, 1, 2],
    [2, 1, 0],
    [1, 0, 2],
    [0, 2, 1],
    [2, 0, 1],
    [1, 2, 0],
  ])
    expect(boardReadingOrder(order.map((i) => items[i]!)).map((item) => item.id)).toEqual([
      'B',
      'C',
      'A',
    ])
})

it('80px 边界属于当前行，81px 开始下一行，不按相邻距离连锁合并', () => {
  expect(
    boardReadingOrder([
      { id: 'A', x: 100, y: 0 },
      { id: 'B', x: 0, y: 80 },
      { id: 'C', x: -100, y: 81 },
    ]).map((item) => item.id),
  ).toEqual(['B', 'A', 'C'])
})

it('重叠位置按 ID 稳定排序，不改变输入顺序', () => {
  const items = ['c', 'a', 'b'].map((id) => ({ id, x: 0, y: 0 }))
  expect(boardReadingOrder(items).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  expect(items.map((item) => item.id)).toEqual(['c', 'a', 'b'])
})

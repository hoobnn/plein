import { describe, expect, it } from 'vite-plus/test'
import { LIBRARY_KINDS, libraryKind, orderedImages, slotImages } from './library'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('资产库参考图分槽位', () => {
  it('第一张进第一个槽位，其余进可多张的槽位，重复的只留一次', () => {
    expect(slotImages(libraryKind('character')!, [A, B, A])).toEqual([
      { slot: 'main', assetId: A },
      { slot: 'extra', assetId: B },
    ])
  })

  it('只有单张槽位时多出来的图丢掉', () => {
    expect(slotImages(libraryKind('effect')!, [A, B])).toEqual([{ slot: 'cover', assetId: A }])
  })

  it('每个分类至少有一个槽位，没有图时返回空', () => {
    for (const kind of LIBRARY_KINDS) {
      expect(kind.slots.length, kind.id).toBeGreaterThan(0)
      expect(slotImages(kind, [])).toEqual([])
    }
  })
})

describe('资产库参考图排序', () => {
  it('按槽位定义的顺序排，未知槽位放最后，同槽位保持原顺序', () => {
    const images = [
      { slot: 'extra', id: 1 },
      { slot: 'gone', id: 2 },
      { slot: 'main', id: 3 },
      { slot: 'extra', id: 4 },
      { slot: 'half', id: 5 },
    ]
    expect(orderedImages(libraryKind('character')!, images).map((i) => i.id)).toEqual([
      3, 5, 1, 4, 2,
    ])
  })
})

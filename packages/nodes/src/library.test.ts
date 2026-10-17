import { describe, expect, it } from 'vite-plus/test'
import {
  CHARACTER_IMAGE_SLOTS,
  LIBRARY_KINDS,
  libraryKind,
  libraryReferenceImageIds,
  normalizeLibraryImages,
  orderedImages,
  preserveLibraryImageSlots,
  slotImages,
} from './library'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('资产库参考图分槽位', () => {
  it('第一张进第一个槽位，其余进可多张的槽位，重复的只留一次', () => {
    expect(slotImages(libraryKind('character')!, [A, B, A])).toEqual([
      { slot: 'full_body', assetId: A },
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

describe('角色基础图片槽位兼容', () => {
  it('四个核心槽位固定生成顺序，旧槽位按原用途映射，不改变原数组', () => {
    expect(CHARACTER_IMAGE_SLOTS.map((slot) => slot.id)).toEqual([
      'full_body',
      'portrait',
      'character_3view',
      'face_grid',
    ])
    const legacy = ['main', 'half', 'sheet', 'emotions', 'extra', 'head_3view'].map((slot, id) => ({
      slot,
      assetId: String(id),
      caption: `图 ${id}`,
    }))
    const expected = legacy.map((image, index) => ({
      ...image,
      slot: ['full_body', 'portrait', 'character_3view', 'face_grid', 'extra', 'head_3view'][
        index
      ]!,
    }))
    expect(normalizeLibraryImages('character', legacy)).toEqual(expected)
    expect(legacy.map((image) => image.slot)).toEqual([
      'main',
      'half',
      'sheet',
      'emotions',
      'extra',
      'head_3view',
    ])
    expect(normalizeLibraryImages('character', expected)).toEqual(expected)
  })

  it('重复核心槽位转入其他参考，同一素材的不同用途和未知槽位均无损保留', () => {
    const images = [
      { slot: 'main', assetId: A },
      { slot: 'full_body', assetId: B },
      { slot: 'portrait', assetId: A },
      { slot: 'half', assetId: B },
      { slot: 'constructor', assetId: B },
      { slot: 'extra', assetId: B },
    ]
    const normalized = normalizeLibraryImages(libraryKind('character')!, images)
    expect(normalized).toEqual([
      { slot: 'full_body', assetId: A },
      { slot: 'extra', assetId: B },
      { slot: 'portrait', assetId: A },
      { slot: 'extra', assetId: B },
      { slot: 'constructor', assetId: B },
      { slot: 'extra', assetId: B },
    ])
    expect(normalizeLibraryImages('character', normalized)).toEqual(normalized)
    expect(normalizeLibraryImages('scene', images)).toEqual(images)
  })

  it('从画布回存时恢复全部图片用途，保留未知槽，去掉已断开的素材并接受新图', () => {
    const previous = [
      { slot: 'main', assetId: A },
      { slot: 'half', assetId: A },
      { slot: 'head_3view', assetId: A },
      { slot: 'sheet', assetId: B },
    ]
    const current = slotImages(libraryKind('character')!, [A, 'new-image'])
    expect(preserveLibraryImageSlots('character', current, previous)).toEqual([
      { slot: 'full_body', assetId: A },
      { slot: 'portrait', assetId: A },
      { slot: 'head_3view', assetId: A },
      { slot: 'extra', assetId: 'new-image' },
    ])
  })
})

describe('资产库参考图排序', () => {
  it('画布素材按槽位顺序去重，图片的多种用途仍完整保留在条目中', () => {
    const images = [
      { slot: 'face_grid', assetId: B },
      { slot: 'half', assetId: A },
      { slot: 'sheet', assetId: 'sheet-image' },
      { slot: 'main', assetId: A },
      { slot: 'extra', assetId: 'extra-image' },
      { slot: 'head_3view', assetId: B },
    ]
    expect(libraryReferenceImageIds(libraryKind('character')!, images)).toEqual([
      A,
      'sheet-image',
      B,
      'extra-image',
    ])
    expect(images).toHaveLength(6)
  })

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

  it('新旧核心槽位混用时仍维持原生成顺序，重复图不丢失', () => {
    const images = [
      { slot: 'face_grid', id: 1 },
      { slot: 'head_3view', id: 2 },
      { slot: 'half', id: 3 },
      { slot: 'sheet', id: 4 },
      { slot: 'main', id: 5 },
      { slot: 'full_body', id: 6 },
    ]
    expect(orderedImages(libraryKind('character')!, images)).toEqual([
      { slot: 'full_body', id: 5 },
      { slot: 'portrait', id: 3 },
      { slot: 'character_3view', id: 4 },
      { slot: 'face_grid', id: 1 },
      { slot: 'extra', id: 6 },
      { slot: 'head_3view', id: 2 },
    ])
  })
})

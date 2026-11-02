import { describe, expect, it } from 'vite-plus/test'
import { stableStringify } from './index'

describe('stableStringify', () => {
  it('与键顺序无关', () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: undefined, z: null }] })).toBe(
      stableStringify({ a: [{ z: null, y: 2 }], b: 1 }),
    )
  })

  it('值不同则字符串不同，数组里的 undefined 写成 null', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }))
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }))
    expect(stableStringify([1, undefined])).toBe('[1,null]')
  })

  it('稀疏数组的空槽与 undefined 一样写成 null，不与空数组共用缓存键', () => {
    const sparse: unknown[] = []
    sparse.length = 1
    expect(stableStringify(sparse)).toBe('[null]')
    expect(stableStringify(sparse)).not.toBe(stableStringify([]))
  })
})

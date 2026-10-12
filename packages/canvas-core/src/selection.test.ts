import { describe, expect, it } from 'vitest'
import { Selection } from './selection'

describe('Selection', () => {
  it('内容没变时不通知', () => {
    const sel = new Selection()
    let changed = 0
    sel.onChange(() => changed++)
    sel.set(['a', 'b'])
    sel.set(['b', 'a'])
    expect(changed).toBe(1)
    sel.set(['a'])
    expect(changed).toBe(2)
  })

  it('prune 去掉已不存在的元素，全都在时不通知', () => {
    const sel = new Selection()
    sel.set(['a', 'b', 'c'])
    let changed = 0
    sel.onChange(() => changed++)
    sel.prune(() => true)
    expect(changed).toBe(0)
    sel.prune((id) => id !== 'b')
    expect(sel.values()).toEqual(['a', 'c'])
    expect(changed).toBe(1)
  })
})

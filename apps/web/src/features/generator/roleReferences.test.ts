import type { PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { checkedImages, roleViews, togglePick } from './roleReferences'

const data = {
  refs: [
    { kind: 'character', elementId: 'r', name: '叶舒', available: ['a', 'b', 'c'], sent: ['a'] },
    { kind: 'character', elementId: 'r', name: '叶舒（校服）', available: ['d', 'a'], sent: ['d'] },
    { kind: 'scene', elementId: 's', name: '天台', available: ['x'], sent: ['x'] },
  ],
} as unknown as PreparedInput

it('同一角色多处引用合并：可选取并集、送入取并集，场景不算', () => {
  const [role, ...rest] = roleViews(data, {}, () => '叶舒')
  expect(rest).toEqual([])
  expect(role).toMatchObject({ name: '叶舒', available: ['a', 'b', 'c', 'd'], sent: ['a', 'd'] })
})

it('点一张：自动模式从自动选中的图起算，结果按卡片顺序；只剩最后一张再点是空', () => {
  const [auto] = roleViews(data, {}, () => '叶舒')
  expect(checkedImages(auto!)).toEqual(['a', 'd'])
  expect(togglePick(auto!, 'b')).toEqual(['a', 'b', 'd'])
  const [manual] = roleViews(data, { r: ['d', 'a'] }, () => '叶舒')
  expect(togglePick(manual!, 'c')).toEqual(['a', 'c', 'd'])
  const [one] = roleViews(data, { r: ['c'] }, () => '叶舒')
  expect(togglePick(one!, 'c')).toEqual([])
})

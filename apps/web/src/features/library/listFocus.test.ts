import { expect, it } from 'vite-plus/test'
import { listFocusTarget } from './listFocus'

it('返回原资产按稳定 ID 定位，目标消失或新建后返回查询框', () => {
  expect(listFocusTarget(['a', 'b'], 'b', null, false)).toBe('b')
  expect(listFocusTarget(['a'], 'b', null, false)).toBeNull()
  expect(listFocusTarget(['a'], null, null, false)).toBeNull()
})
it('当前卡片撤下后选择同位置的下一项，末尾选择上一项，空列表选择查询框', () => {
  expect(listFocusTarget(['b', 'c'], undefined, { id: 'a', index: 0 }, true)).toBe('b')
  expect(listFocusTarget(['b'], undefined, { id: 'a', index: 1 }, true)).toBe('b')
  expect(listFocusTarget([], undefined, { id: 'a', index: 0 }, true)).toBeNull()
})
it('用户主动改变焦点、当前项仍存在或尚未进入卡片时不移动焦点', () => {
  expect(listFocusTarget(['b'], undefined, { id: 'a', index: 0 }, false)).toBeUndefined()
  expect(listFocusTarget(['a', 'b'], undefined, { id: 'a', index: 0 }, true)).toBeUndefined()
  expect(listFocusTarget([], undefined, null, true)).toBeUndefined()
})

import { expect, it } from 'vite-plus/test'
import { stateValueText } from './continuityModel'

const subjects = [{ id: 's1', label: '林夏' }]

it('holder 状态用主体 label 与左右手描述，不暴露内部 id', () => {
  expect(stateValueText('holder', { subjectId: 's1', hand: 'right' }, subjects)).toBe('林夏 · 右手')
  expect(stateValueText('holder', { subjectId: 's1', hand: 'both' }, subjects)).toBe('林夏 · 双手')
  expect(stateValueText('holder', { subjectId: 'gone', hand: 'left' }, subjects)).toBe(
    '未知主体 · 左手',
  )
})

it('字符串原样显示，其余结构化值保底 JSON', () => {
  expect(stateValueText('pose', '撑着栏杆', subjects)).toBe('撑着栏杆')
  expect(stateValueText('condition', { odd: 1 }, subjects)).toBe('{"odd":1}')
})

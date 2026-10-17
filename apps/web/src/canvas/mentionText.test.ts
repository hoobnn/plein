import { expect, test } from 'vite-plus/test'
import { mentionParts } from './mentionText'

test('有效、缺失、中文相邻和带空格的引用保持原文及偏移，邮件不误报', () => {
  const text = '联系 test@example.com。看着@旧角色，@小岚 · 测试 与 @Missing#2/青年。'
  const parts = mentionParts(text, [{ id: 'role', name: '小岚 · 测试' }])
  expect(parts.map((p) => p.text).join('')).toBe(text)
  for (const p of parts) expect(text.slice(p.start, p.start + p.text.length)).toBe(p.text)
  expect(parts.filter((p) => p.mention).map((p) => [p.text, p.id, !!p.missing])).toEqual([
    ['@旧角色', undefined, true],
    ['@小岚 · 测试', 'role', false],
    ['@Missing#2/青年', undefined, true],
  ])
})

test('重名与无效序号保持消歧警示，不把任一目标误标为已解析', () => {
  const targets = [
    { id: 'a', name: '林夏' },
    { id: 'b', name: '林夏' },
  ]
  const parts = mentionParts('@林夏 @林夏#9 @林夏#2', targets).filter((p) => p.mention)
  expect(parts[0]?.warning).toContain('请写成')
  expect(parts[1]?.warning).toContain('不存在')
  expect(parts[0]?.id).toBeUndefined()
  expect(parts[1]?.id).toBeUndefined()
  expect(parts[2]).toMatchObject({ id: 'b', warning: undefined })
})

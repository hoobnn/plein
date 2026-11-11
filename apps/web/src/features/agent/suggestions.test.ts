import { expect, it } from 'vite-plus/test'
import { agentSuggestions, suggestionNeedsInput } from './suggestions'

it('按画布状态选取示例', () => {
  const empty = agentSuggestions({ elementCount: 0, selectedCount: 0 })
  expect(empty.some((s) => s.includes('选中'))).toBe(false)
  const idle = agentSuggestions({ elementCount: 3, selectedCount: 0 })
  expect(idle.some((s) => s.includes('选中'))).toBe(false)
  expect(idle).not.toEqual(empty)
  const picked = agentSuggestions({ elementCount: 3, selectedCount: 1 })
  expect(picked.some((s) => s.includes('选中'))).toBe(true)
})

it('以冒号结尾的示例只填入草稿', () => {
  expect(suggestionNeedsInput('帮我把这个创意做成一分钟短剧：')).toBe(true)
  expect(suggestionNeedsInput('先帮我写一个三幕剧本')).toBe(false)
})

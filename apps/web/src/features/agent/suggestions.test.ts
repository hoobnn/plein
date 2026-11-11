import { expect, it } from 'vite-plus/test'
import { agentSuggestions } from './suggestions'

it('按画布状态选取示例', () => {
  const empty = agentSuggestions({ elementCount: 0, selectedCount: 0 })
  expect(empty.some((s) => s.includes('选中'))).toBe(false)
  const idle = agentSuggestions({ elementCount: 3, selectedCount: 0 })
  expect(idle.some((s) => s.includes('选中'))).toBe(false)
  expect(idle).not.toEqual(empty)
  const picked = agentSuggestions({ elementCount: 3, selectedCount: 1 })
  expect(picked.some((s) => s.includes('选中'))).toBe(true)
})

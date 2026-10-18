import { expect, it } from 'vite-plus/test'
import { settleSavedDraft } from './savedDraft'

it('输入未变或修改后撤回原内容时接手规范化结果，并可继续放置', () => {
  const submitted = { name: ' 名称 ', images: ['a'] }
  const normalized = { name: '名称', images: ['a'] }
  for (const current of [submitted, structuredClone(submitted)]) {
    expect(settleSavedDraft(submitted, current, normalized, true)).toEqual({
      draft: normalized,
      continuePlacement: true,
      notice: null,
    })
  }
})
it('普通保存保留新草稿，下一次保存仍可提交新内容', () => {
  const submitted = { name: '提交名称', images: ['a'] }
  const current = { name: '新名称', images: ['a', 'b'] }
  const result = settleSavedDraft(submitted, current, submitted, false)
  expect(result.draft).toBe(current)
  expect(result.notice).toBeNull()
  expect(settleSavedDraft(current, current, current, true).continuePlacement).toBe(true)
})
it('保存并放置时发现新输入则保留草稿并明确提示，不使用旧版本继续关闭', () => {
  const submitted = { name: '名称', profile: { periods: [] as string[] } }
  const current = { name: '名称', profile: { periods: ['青年'] } }
  const result = settleSavedDraft(submitted, current, submitted, true)
  expect(result.draft).toBe(current)
  expect(result.continuePlacement).toBe(false)
  expect(result.notice).toContain('仍有新修改')
})

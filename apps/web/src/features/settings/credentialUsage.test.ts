import { describe, expect, it } from 'vite-plus/test'
import { credentialUsed, removalImpact, replaceWarning, usageSummary } from './credentialUsage'

describe('密钥组使用情况的文案', () => {
  it('删除确认按数量说明任务与音色的后果', () => {
    expect(removalImpact({ tasks: 2, voices: 3 })).toBe(
      '有 2 个任务的结果还没取回、3 个音色属于这组 Key。删除后这些结果无法再取回，这些音色也无法再配音。',
    )
    expect(removalImpact({ tasks: 1, voices: 0 })).toBe(
      '有 1 个任务的结果还没取回。删除后这些结果无法再取回。',
    )
    expect(removalImpact({ tasks: 0, voices: 1 })).toBe(
      '1 个音色属于这组 Key。删除后这些音色也无法再配音。',
    )
  })

  it('全为 0 时不加说明，保持简短确认', () => {
    expect(removalImpact({ tasks: 0, voices: 0 })).toBeNull()
    expect(credentialUsed({ tasks: 0, voices: 0 })).toBe(false)
    expect(credentialUsed({ tasks: 1, voices: 0 })).toBe(true)
    expect(credentialUsed({ tasks: 0, voices: 2 })).toBe(true)
  })

  it('替换提示列出名下的任务与音色，并指向添加新组', () => {
    expect(replaceWarning({ tasks: 2, voices: 3 })).toBe(
      '这组 Key 下有 2 个任务的结果还没取回、3 个音色。如果新 Key 属于另一个账号，它们会失效；换账号建议「添加一组密钥」。',
    )
    expect(replaceWarning({ tasks: 0, voices: 1 })).toBe(
      '这组 Key 下有 1 个音色。如果新 Key 属于另一个账号，它们会失效；换账号建议「添加一组密钥」。',
    )
  })

  it('卡片摘要只列非零项，全为 0 时不显示', () => {
    expect(usageSummary({ tasks: 2, voices: 3 })).toBe('2 个任务待取回 · 3 个音色')
    expect(usageSummary({ tasks: 1, voices: 0 })).toBe('1 个任务待取回')
    expect(usageSummary({ tasks: 0, voices: 2 })).toBe('2 个音色')
    expect(usageSummary({ tasks: 0, voices: 0 })).toBeNull()
  })
})

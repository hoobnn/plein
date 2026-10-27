import { describe, expect, it } from 'vite-plus/test'
import { runBlockReason, runDisabled } from './runBlock'

const base = {
  canceling: false,
  awaitingAcceptance: false,
  problem: null,
  running: false,
  requiresInput: false,
  loading: false,
  hasInput: false,
  stale: false,
  error: false,
}

describe('生成按钮的禁用原因', () => {
  it('可以生成时不禁用，也没有原因', () => {
    expect(runDisabled(base)).toBe(false)
    expect(runBlockReason(base)).toBeNull()
    expect(runDisabled({ ...base, hasInput: true })).toBe(false)
  })

  it('正在取消或提交时禁用，并说清在做什么', () => {
    expect(runDisabled({ ...base, canceling: true })).toBe(true)
    expect(runBlockReason({ ...base, canceling: true })).toBe('正在停止任务…')
    expect(runDisabled({ ...base, awaitingAcceptance: true })).toBe(true)
    expect(runBlockReason({ ...base, awaitingAcceptance: true })).toBe('正在提交生成请求…')
  })

  it('有校验问题时禁用，���用面板上已经写明的原因', () => {
    const problem = '填写提示词，或连入上游文本'
    expect(runDisabled({ ...base, problem })).toBe(true)
    expect(runBlockReason({ ...base, problem })).toBe(problem)
  })

  it('实际输入还没备好时禁用，说明正在准备', () => {
    expect(runDisabled({ ...base, requiresInput: true })).toBe(true)
    expect(runBlockReason({ ...base, requiresInput: true })).toBe(
      '正在准备实际输入，备好后即可生成',
    )
  })

  it('输入还在准备时不锁死按钮：按下先记下，备好后自动提交', () => {
    const loading = { ...base, requiresInput: true, loading: true }
    expect(runDisabled(loading)).toBe(false)
    expect(runBlockReason(loading)).toBeNull()
  })

  it('实际输入已过期时禁用并说明在重算', () => {
    expect(runDisabled({ ...base, requiresInput: true, hasInput: true, stale: true })).toBe(true)
    expect(runBlockReason({ ...base, requiresInput: true, hasInput: true, stale: true })).toBe(
      '实际输入已更新，正在重新准备…',
    )
  })

  it('读取实际输入失败时不锁死生成，用户还能提交', () => {
    const failed = { ...base, requiresInput: true, hasInput: true, stale: true, error: true }
    expect(runDisabled(failed)).toBe(false)
    expect(runBlockReason(failed)).toBeNull()
  })

  it('任务在跑时不因为输入问题禁用（那是取消按钮）', () => {
    const running = { ...base, running: true, requiresInput: true }
    expect(runDisabled(running)).toBe(false)
  })
})

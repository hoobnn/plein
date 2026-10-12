import { beforeEach, describe, expect, it } from 'vitest'
import { abortGroupRuns, groupRunSignal, useGroupRuns } from './groupRuns'

const runs = () => useGroupRuns.getState().runs
const { begin, started, end } = useGroupRuns.getState()

beforeEach(() => useGroupRuns.setState({ runs: {} }))

describe('整组运行登记', () => {
  it('同一个 Frame 在运行时不能再发起，结束后可以', () => {
    expect(begin('f1')).toBe(true)
    expect(begin('f1')).toBe(false)
    expect(begin('f2')).toBe(true)
    started('f1', 'g1')
    expect(runs()).toEqual({ f1: 'g1', f2: null })
    end('f1')
    expect(begin('f1')).toBe(true)
  })

  it('已经结束的运行晚到的 id 不再登记', () => {
    begin('f1')
    end('f1')
    started('f1', 'g1')
    expect(runs()).toEqual({})
  })

  it('离开画布时中止轮询、清空登记，之后换一个新的信号', () => {
    begin('f1')
    const signal = groupRunSignal()
    abortGroupRuns()
    expect(signal.aborted).toBe(true)
    expect(runs()).toEqual({})
    expect(groupRunSignal().aborted).toBe(false)
  })
})

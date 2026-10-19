import type { Engine } from '@plein/canvas-core'
import type { StaleNodes } from '@plein/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { refreshStale, useStale, watchStale } from './stale'

vi.mock('../../api/client', () => ({ api: { canvasStale: vi.fn() } }))

/** 只有 subscribe 的文档：手动触发变化 */
function fakeEngine() {
  const listeners = new Set<() => void>()
  const doc = {
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return {
    engine: { doc } as unknown as Engine,
    change: () => {
      for (const f of listeners) f()
    },
    listeners,
  }
}

/** 每次查询的应答都由测试放行 */
function answers() {
  const pending: Array<(s: StaleNodes) => void> = []
  vi.mocked(api.canvasStale).mockImplementation(
    () => new Promise<StaleNodes>((r) => pending.push(r)),
  )
  return pending
}

const nodes = () => Object.fromEntries(useStale.getState().nodes)

beforeEach(() => {
  vi.useFakeTimers()
  useStale.getState().set(null)
})
afterEach(() => {
  vi.useRealTimers()
  vi.mocked(api.canvasStale).mockReset()
})

describe('过期节点', () => {
  it('文档变化停一会儿才查，连续改动只查一次', async () => {
    answers()
    const { engine, change } = fakeEngine()
    watchStale(engine, 'c1')
    expect(api.canvasStale).toHaveBeenCalledTimes(1)
    change()
    await vi.advanceTimersByTimeAsync(1000)
    change()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.canvasStale).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(api.canvasStale).toHaveBeenCalledTimes(2)
  })

  it('先发的查询晚到时丢掉，不盖掉新的结果', async () => {
    const pending = answers()
    const { engine, change } = fakeEngine()
    watchStale(engine, 'c1')
    change()
    await vi.advanceTimersByTimeAsync(1200)
    // c 过期但用户确认过保留
    pending[1]!({ stale: ['b'], upstream: ['c'], kept: ['c'] })
    await vi.advanceTimersByTimeAsync(0)
    pending[0]!({ stale: ['a'], upstream: [], kept: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(nodes()).toEqual({ b: 'self', c: 'kept' })
  })

  it('防抖等待期间也不接受改动前的旧应答', async () => {
    const pending = answers()
    const { engine, change } = fakeEngine()
    const stop = watchStale(engine, 'c1')
    change()
    pending[0]!({ stale: ['old'], upstream: [], kept: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(nodes()).toEqual({})
    await vi.advanceTimersByTimeAsync(1200)
    pending[1]!({ stale: ['new'], upstream: [], kept: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(nodes()).toEqual({ new: 'self' })
    stop()
  })

  it('停止后清空、退订，晚到的应答也不再写入', async () => {
    const pending = answers()
    const { engine, change, listeners } = fakeEngine()
    const stop = watchStale(engine, 'c1')
    stop()
    expect(listeners.size).toBe(0)
    pending[0]!({ stale: ['a'], upstream: [], kept: [] })
    change()
    await vi.advanceTimersByTimeAsync(5000)
    expect(nodes()).toEqual({})
    expect(api.canvasStale).toHaveBeenCalledTimes(1)
  })
})

describe('保留决定后的显式刷新', () => {
  it('立即刷新并取消等待中的防抖，旧响应不能覆盖新的保留状态', async () => {
    const pending = answers()
    const { engine, change } = fakeEngine()
    const stop = watchStale(engine, 'c1')
    change()
    refreshStale(engine, 'c1')
    expect(api.canvasStale).toHaveBeenCalledTimes(2)
    pending[1]!({ stale: ['a'], upstream: [], kept: ['a'] })
    await vi.advanceTimersByTimeAsync(0)
    pending[0]!({ stale: ['a'], upstream: [], kept: [] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(nodes()).toEqual({ a: 'kept' })
    expect(api.canvasStale).toHaveBeenCalledTimes(2)
    stop()
    refreshStale(engine, 'c1')
    expect(api.canvasStale).toHaveBeenCalledTimes(2)
  })

  it('旧引擎的清理和旧画布的刷新不干扰新画布', async () => {
    const pending = answers()
    const old = fakeEngine()
    const current = fakeEngine()
    const stopOld = watchStale(old.engine, 'old')
    useStale.getState().set({ stale: ['old'], upstream: [], kept: [] })
    const stop = watchStale(current.engine, 'current')
    expect(nodes()).toEqual({})
    pending[1]!({ stale: ['new'], upstream: [], kept: [] })
    await vi.advanceTimersByTimeAsync(0)
    stopOld()
    refreshStale(old.engine, 'old')
    refreshStale(current.engine, 'old')
    pending[0]!({ stale: ['old'], upstream: [], kept: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(nodes()).toEqual({ new: 'self' })
    expect(api.canvasStale).toHaveBeenCalledTimes(2)
    refreshStale(current.engine, 'current')
    pending[2]!({ stale: ['new'], upstream: [], kept: ['new'] })
    await vi.advanceTimersByTimeAsync(0)
    expect(nodes()).toEqual({ new: 'kept' })
    stop()
  })
})

import type { Engine } from '@plein/canvas-core'
import type { StaleNodes } from '@plein/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../../api/client'
import { useStale, watchStale } from './stale'

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
    pending[1]!({ stale: ['b'], upstream: ['c'] })
    await vi.advanceTimersByTimeAsync(0)
    pending[0]!({ stale: ['a'], upstream: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(nodes()).toEqual({ b: 'self', c: 'upstream' })
  })

  it('停止后清空、退订，晚到的应答也不再写入', async () => {
    const pending = answers()
    const { engine, change, listeners } = fakeEngine()
    const stop = watchStale(engine, 'c1')
    stop()
    expect(listeners.size).toBe(0)
    pending[0]!({ stale: ['a'], upstream: [] })
    change()
    await vi.advanceTimersByTimeAsync(5000)
    expect(nodes()).toEqual({})
    expect(api.canvasStale).toHaveBeenCalledTimes(1)
  })
})

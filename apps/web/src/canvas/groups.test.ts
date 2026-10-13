import type { GroupRunState } from '@plein/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ApiError, api } from '../api/client'
import { runGroup } from './groups'

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: { runFrame: vi.fn(), groupRun: vi.fn() },
}))

const state = (status: string, summary?: Record<string, number>) =>
  ({ status, summary }) as unknown as GroupRunState
const done = state('succeeded', { succeeded: 2, cached: 1 })

/** 依次给出查询结果（Error 当作失败），并记下每次查询的时刻 */
function polls(...answers: Array<GroupRunState | Error>) {
  const at: number[] = []
  vi.mocked(api.groupRun).mockImplementation(async () => {
    at.push(Date.now())
    const a = answers.shift()!
    if (a instanceof Error) throw a
    return a
  })
  return at
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  vi.mocked(api.runFrame).mockResolvedValue({ groupId: 'g1' } as never)
})
afterEach(() => {
  vi.useRealTimers()
  vi.mocked(api.groupRun).mockReset()
})

describe('整组运行轮询', () => {
  it('服务端 5xx、网络错误时翻倍退避重试，查到一次就恢复原间隔', async () => {
    const at = polls(new ApiError(503, 'x', ''), state('running'), new TypeError('fetch'), done)
    const onStart = vi.fn()
    const run = runGroup('c', 'f', { onStart })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(run).resolves.toEqual({
      succeeded: 2,
      cached: 1,
      failed: 0,
      canceled: 0,
      skipped: 0,
      stopped: false,
    })
    expect(onStart).toHaveBeenCalledWith('g1')
    expect(at).toEqual([1000, 3000, 4000, 6000])
  })

  it('连续失败超过重试次数才放弃', async () => {
    const err = () => new ApiError(502, 'x', '')
    const at = polls(err(), err(), err(), err(), err())
    const run = runGroup('c', 'f')
    const failed = expect(run).rejects.toThrow('查不到整组运行的进度')
    await vi.advanceTimersByTimeAsync(60_000)
    await failed
    expect(at).toEqual([1000, 3000, 7000, 15000, 31000])
  })

  it('4xx 不是偶发错误，立即抛出', async () => {
    const gone = new ApiError(404, 'not_found', '没有这次运行')
    const at = polls(gone)
    const run = runGroup('c', 'f')
    const failed = expect(run).rejects.toBe(gone)
    await vi.advanceTimersByTimeAsync(60_000)
    await failed
    expect(at).toHaveLength(1)
  })

  it('整组被停止时 stopped 为 true', async () => {
    polls(state('canceled', { succeeded: 1, canceled: 2 }))
    const run = runGroup('c', 'f')
    await vi.advanceTimersByTimeAsync(1000)
    await expect(run).resolves.toMatchObject({ succeeded: 1, canceled: 2, stopped: true })
  })

  it('中止时抛出 signal 的原因：等待中、查询中、发起前都一样', async () => {
    const reason = new Error('离开画布')
    // 等待下一次查询时中止
    let ctl = new AbortController()
    let run = runGroup('c', 'f', { signal: ctl.signal })
    let failed = expect(run).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(500)
    ctl.abort(reason)
    await failed
    expect(api.groupRun).not.toHaveBeenCalled()

    // 查询请求被中止（fetch 抛 AbortError），仍报 signal 的原因
    ctl = new AbortController()
    vi.mocked(api.groupRun).mockImplementation(async () => {
      ctl.abort(reason)
      throw new DOMException('aborted', 'AbortError')
    })
    run = runGroup('c', 'f', { signal: ctl.signal })
    failed = expect(run).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(1000)
    await failed

    // 已中止的信号不发起运行
    vi.mocked(api.runFrame).mockClear()
    await expect(runGroup('c', 'f', { signal: ctl.signal })).rejects.toBe(reason)
    expect(api.runFrame).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { waitForWeb } from './web-ready'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('桌面开发页面启动', () => {
  it('网络失败或非成功状态后重试，成功即停止等待', async () => {
    vi.useFakeTimers()
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchPage)
    const ready = waitForWeb('http://localhost:5173', 1000)
    await vi.advanceTimersByTimeAsync(600)
    await ready
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(fetchPage).toHaveBeenLastCalledWith('http://localhost:5173', {
      signal: expect.any(AbortSignal),
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('期限到达后报告页面地址，不会继续打开不可用页面', async () => {
    vi.useFakeTimers()
    const fetchPage = vi.fn().mockResolvedValue({ ok: false })
    vi.stubGlobal('fetch', fetchPage)
    const ready = waitForWeb('http://localhost:5173', 1000)
    const rejected = expect(ready).rejects.toThrow('开发页面在 1 秒内未就绪：http://localhost:5173')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(fetchPage).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('一直不返回响应的请求也会被启动期限中止', async () => {
    let signal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, options: RequestInit) => {
        signal = options.signal as AbortSignal
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
        })
      }),
    )
    await expect(waitForWeb('http://localhost:5173', 20)).rejects.toThrow(
      '开发页面在 0.02 秒内未就绪：http://localhost:5173',
    )
    expect(signal?.aborted).toBe(true)
  })
})

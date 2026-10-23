import type { AudioPeaks } from '@plein/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { PeaksCache } from './peaks'

const fetchPeaks = vi.fn<typeof fetch>()
beforeEach(() => {
  fetchPeaks.mockReset()
  vi.stubGlobal('fetch', fetchPeaks)
})
afterEach(() => vi.unstubAllGlobals())

const data = (count: number, value = 0.5): AudioPeaks => ({
  rate: 100,
  peaks: Array.from({ length: count }, () => value),
})
const response = (count: number, value?: number) => Response.json(data(count, value))

function deferred() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('波形峰值缓存', () => {
  it('同一素材并发读取只发一次请求，成功后复用解析结果', async () => {
    const cache = new PeaksCache(10)
    const request = deferred()
    fetchPeaks.mockReturnValueOnce(request.promise)
    const first = cache.load('shared')
    expect(cache.load('shared')).toBe(first)
    expect(fetchPeaks).toHaveBeenCalledExactlyOnceWith('/api/assets/shared/peaks')
    request.resolve(response(4))
    const result = await first
    expect(result).toEqual(data(4))
    expect(await cache.load('shared')).toBe(result)
    expect(fetchPeaks).toHaveBeenCalledTimes(1)
  })

  it.each(['http', 'network', 'json'] as const)('%s 失败后同一素材可重试', async (failure) => {
    const cache = new PeaksCache(10)
    if (failure === 'network') fetchPeaks.mockRejectedValueOnce(new Error('offline'))
    else
      fetchPeaks.mockResolvedValueOnce(
        failure === 'http' ? new Response(null, { status: 503 }) : new Response('{'),
      )
    expect(await cache.load('retry')).toBeNull()
    fetchPeaks.mockResolvedValueOnce(response(4))
    expect(await cache.load('retry')).toEqual(data(4))
    expect(fetchPeaks).toHaveBeenCalledTimes(2)
  })

  it('命中会更新 LRU，按峰值总量淘汰最久未用结果', async () => {
    const cache = new PeaksCache(6)
    fetchPeaks.mockImplementation(async () => response(3))
    const a = await cache.load('a')
    await cache.load('b')
    expect(await cache.load('a')).toBe(a)
    await cache.load('c')
    expect(await cache.load('a')).toBe(a)
    expect(fetchPeaks).toHaveBeenCalledTimes(3)
    await cache.load('b')
    expect(fetchPeaks).toHaveBeenCalledTimes(4)
  })

  it('新结果较大时淘汰足够多的旧素材，仍可缓存预算以内的单项', async () => {
    const cache = new PeaksCache(6)
    fetchPeaks
      .mockResolvedValueOnce(response(2))
      .mockResolvedValueOnce(response(3))
      .mockResolvedValueOnce(response(5))
    await cache.load('a')
    const b = await cache.load('b')
    const c = await cache.load('c')
    expect(await cache.load('c')).toBe(c)
    fetchPeaks.mockResolvedValueOnce(response(3))
    expect(await cache.load('b')).not.toBe(b)
    expect(fetchPeaks).toHaveBeenCalledTimes(4)
  })

  it('预算在成功响应到达时结算，尚在请求的素材仍保持去重', async () => {
    const cache = new PeaksCache(6)
    const a = deferred()
    const b = deferred()
    const c = deferred()
    fetchPeaks
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(c.promise)
    const first = cache.load('a')
    const second = cache.load('b')
    const third = cache.load('c')
    b.resolve(response(3))
    const bData = await second
    c.resolve(response(3))
    const cData = await third
    expect(cache.load('a')).toBe(first)
    a.resolve(response(3))
    const aData = await first
    expect(await cache.load('c')).toBe(cData)
    expect(await cache.load('a')).toBe(aData)
    expect(fetchPeaks).toHaveBeenCalledTimes(3)
    fetchPeaks.mockResolvedValueOnce(response(3))
    expect(await cache.load('b')).not.toBe(bData)
    expect(fetchPeaks).toHaveBeenCalledTimes(4)
  })

  it('淘汰不清空活跃调用者已取得的结果，重访已淘汰素材会重新加载', async () => {
    const cache = new PeaksCache(4)
    fetchPeaks.mockResolvedValueOnce(response(4, 0.8)).mockResolvedValueOnce(response(4, 0.2))
    const active = await cache.load('active')
    await cache.load('other')
    expect(active).toEqual(data(4, 0.8))
    fetchPeaks.mockResolvedValueOnce(response(4, 0.8))
    expect(await cache.load('active')).toEqual(active)
    expect(fetchPeaks).toHaveBeenCalledTimes(3)
  })

  it('超大单项仍去重并交付结果，但不留在共享缓存或挤走可容纳的结果', async () => {
    const cache = new PeaksCache(4)
    fetchPeaks.mockResolvedValueOnce(response(4))
    const small = await cache.load('small')
    const request = deferred()
    fetchPeaks.mockReturnValueOnce(request.promise)
    const first = cache.load('large')
    expect(cache.load('large')).toBe(first)
    request.resolve(response(5))
    expect(await first).toEqual(data(5))
    expect(await cache.load('small')).toBe(small)
    fetchPeaks.mockResolvedValueOnce(response(5))
    expect(await cache.load('large')).toEqual(data(5))
    expect(fetchPeaks).toHaveBeenCalledTimes(3)
  })

  it('空峰值仍是可复用的成功结果，同时受预算约束', async () => {
    const cache = new PeaksCache(1)
    fetchPeaks.mockImplementation(async () => response(0))
    const empty = await cache.load('empty')
    expect(await cache.load('empty')).toBe(empty)
    await cache.load('other-empty')
    expect(await cache.load('empty')).toEqual(data(0))
    expect(fetchPeaks).toHaveBeenCalledTimes(3)
  })
})

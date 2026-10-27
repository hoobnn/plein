// @vitest-environment happy-dom
import type { Asset } from '@plein/protocol'
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { api } from '../api/client'
import {
  ASSET_META_CACHE_LIMIT,
  AssetMetaCache,
  assetMetaCache,
  loadAssetMeta,
  useAssetMeta,
  useAssetMetas,
} from './assetMeta'

const asset = (id: string): Asset => ({
  id,
  kind: 'image',
  mime: 'image/png',
  name: id,
  size: 1024,
  variants: [],
  createdAt: 1,
})
const deferred = () => {
  let resolve!: (asset: Asset) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Asset>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('资产元信息缓存', () => {
  it('请求中去重，完成后释放 Promise，只缓存最近使用的资产', async () => {
    const cache = new AssetMetaCache(2)
    const request = deferred()
    const load = vi.spyOn(api, 'assetMeta').mockReturnValueOnce(request.promise)
    const first = cache.load('a')
    expect(cache.load('a')).toBe(first)
    expect(cache.stats).toEqual({ pending: 1, ready: 0, limit: 2 })
    request.resolve(asset('a'))
    const a = await first
    expect(cache.stats).toEqual({ pending: 0, ready: 1, limit: 2 })
    load.mockImplementation(async (id) => asset(id))
    await cache.load('b')
    expect(cache.get('a')).toBe(a)
    await cache.load('c')
    expect(cache.get('a')).toBe(a)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.stats.ready).toBe(2)
    await cache.load('b')
    expect(load).toHaveBeenCalledTimes(4)
  })

  it('连续读取三倍容量后仍有界，失败移除并发项且允许重试', async () => {
    const cache = new AssetMetaCache()
    const load = vi.spyOn(api, 'assetMeta').mockImplementation(async (id) => asset(id))
    for (let i = 0; i < ASSET_META_CACHE_LIMIT * 3; i++) await cache.load(`asset-${i}`)
    expect(cache.stats).toEqual({
      pending: 0,
      ready: ASSET_META_CACHE_LIMIT,
      limit: ASSET_META_CACHE_LIMIT,
    })
    expect(cache.get('asset-0')).toBeUndefined()
    load.mockRejectedValueOnce(new Error('offline'))
    await expect(cache.load('retry')).rejects.toThrow('offline')
    expect(cache.stats.pending).toBe(0)
    expect(await cache.load('retry')).toEqual(asset('retry'))
  })

  it('乱序完成仍受容量限制，未完成请求不会被淘汰后重复发送', async () => {
    const cache = new AssetMetaCache(1)
    const request = deferred()
    const load = vi
      .spyOn(api, 'assetMeta')
      .mockReturnValueOnce(request.promise)
      .mockImplementation(async (id) => asset(id))
    const first = cache.load('slow')
    await cache.load('fast')
    expect(cache.load('slow')).toBe(first)
    request.resolve(asset('slow'))
    await first
    expect(cache.get('fast')).toBeUndefined()
    expect(cache.stats).toEqual({ pending: 0, ready: 1, limit: 1 })
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('活跃元信息读取', () => {
  it('列表超过共享缓存容量仍全部就绪，重试不会重读已完成项', async () => {
    const load = vi.spyOn(api, 'assetMeta').mockImplementation(async (id) => asset(id))
    const ids = Array.from({ length: ASSET_META_CACHE_LIMIT + 3 }, (_, i) => `list-${i}`)
    const { result, rerender } = renderHook(({ reload }) => useAssetMetas(ids, reload), {
      initialProps: { reload: 0 },
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(ids.every((id) => result.current.get(id)?.id === id)).toBe(true)
    expect(assetMetaCache.stats.ready).toBe(ASSET_META_CACHE_LIMIT)
    rerender({ reload: 1 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(load).toHaveBeenCalledTimes(ids.length)
  })

  it('切换列表后丢弃旧返回，失败重试只请求失败项', async () => {
    const pending = deferred()
    const load = vi
      .spyOn(api, 'assetMeta')
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async (id) => asset(id))
    const { result, rerender } = renderHook(({ ids, reload }) => useAssetMetas(ids, reload), {
      initialProps: { ids: ['old-list'], reload: 0 },
    })
    rerender({ ids: ['failed-list', 'ready-list'], reload: 0 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.errors).toEqual([{ id: 'failed-list', message: 'offline' }])
    await act(async () => pending.resolve(asset('old-list')))
    expect(result.current.get('old-list')).toBeUndefined()
    rerender({ ids: ['failed-list', 'ready-list'], reload: 1 })
    await waitFor(() => expect(result.current.get('failed-list')).toEqual(asset('failed-list')))
    expect(result.current.errors).toEqual([])
    expect(load.mock.calls.map(([id]) => id)).toEqual([
      'old-list',
      'failed-list',
      'ready-list',
      'failed-list',
    ])
  })

  it('旧列表迟到失败不会把已就绪的新列表变回加载中或显示旧错误', async () => {
    function MetadataList({ ids }: { ids: string[] }) {
      const metadata = useAssetMetas(ids)
      return (
        <div>
          <p role="status">{metadata.loading ? '读取中' : '已就绪'}</p>
          <p role="alert">{metadata.errors.map((error) => error.message).join('；')}</p>
          <ul>
            {ids.map((id) => (
              <li key={id}>{metadata.get(id)?.name ?? '尚未读取'}</li>
            ))}
          </ul>
        </div>
      )
    }
    const pending = deferred()
    const load = vi
      .spyOn(api, 'assetMeta')
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async (id) => asset(id))
    const { rerender } = render(<MetadataList ids={['late-error-old']} />)
    expect(screen.getByRole('status').textContent).toBe('读取中')
    rerender(<MetadataList ids={['late-error-current']} />)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已就绪'))
    expect(screen.getByRole('listitem').textContent).toBe('late-error-current')

    await act(async () => pending.reject(new Error('旧列表读取失败')))
    expect(screen.getByRole('status').textContent).toBe('已就绪')
    expect(screen.getByRole('listitem').textContent).toBe('late-error-current')
    expect(screen.getByRole('alert').textContent).toBe('')
    expect(load.mock.calls.map(([id]) => id)).toEqual(['late-error-old', 'late-error-current'])
  })

  it('await 前取得的 getter 能读取外部重试成功值，并在共享缓存淘汰后保留', async () => {
    const load = vi
      .spyOn(api, 'assetMeta')
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async (id) => asset(id))
    const { result, rerender } = renderHook(
      ({ reload }) => useAssetMetas(['external-retry'], reload),
      {
        initialProps: { reload: 0 },
      },
    )
    await waitFor(() => expect(result.current.errors).toHaveLength(1))
    const read = result.current.get
    const retried = await loadAssetMeta('external-retry')
    expect(read('external-retry')).toBe(retried)
    for (let i = 0; i < ASSET_META_CACHE_LIMIT; i++) await loadAssetMeta(`external-other-${i}`)
    expect(assetMetaCache.get('external-retry')).toBeUndefined()
    expect(read('external-retry')).toBe(retried)
    expect(result.current.get('external-retry')).toBe(retried)
    rerender({ reload: 1 })
    await waitFor(() => expect(result.current.errors).toEqual([]))
    expect(result.current.loading).toBe(false)
    expect(result.current.get('external-retry')).toBe(retried)
    expect(load.mock.calls.filter(([id]) => id === 'external-retry')).toHaveLength(2)
  })

  it('重新加载期间旧 getter 跟随同一列表的新结果，切换列表后不会写入新快照', async () => {
    const retry = deferred()
    vi.spyOn(api, 'assetMeta')
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(retry.promise)
      .mockImplementation(async (id) => asset(id))
    const { result, rerender } = renderHook(({ ids, reload }) => useAssetMetas(ids, reload), {
      initialProps: { ids: ['getter-retry'], reload: 0 },
    })
    await waitFor(() => expect(result.current.errors).toHaveLength(1))
    const read = result.current.get
    rerender({ ids: ['getter-retry'], reload: 1 })
    await act(async () => retry.resolve(asset('getter-retry')))
    for (let i = 0; i < ASSET_META_CACHE_LIMIT; i++) await loadAssetMeta(`getter-other-${i}`)
    expect(assetMetaCache.get('getter-retry')).toBeUndefined()
    expect(read('getter-retry')).toEqual(asset('getter-retry'))
    rerender({ ids: ['getter-current'], reload: 1 })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(read('getter-current')).toBeUndefined()
    expect(result.current.errors).toEqual([])
    expect(result.current.get('getter-retry')).toBeUndefined()
    expect(result.current.get('getter-current')).toEqual(asset('getter-current'))
  })

  it('共享缓存淘汰后活跃单项保持结果，切换时不显示旧请求结果', async () => {
    const load = vi.spyOn(api, 'assetMeta').mockImplementation(async (id) => asset(id))
    const { result, rerender } = renderHook(({ id }) => useAssetMeta(id), {
      initialProps: { id: 'active-single' },
    })
    await waitFor(() => expect(result.current?.id).toBe('active-single'))
    await act(async () => {
      for (let i = 0; i < ASSET_META_CACHE_LIMIT; i++) await loadAssetMeta(`other-${i}`)
    })
    expect(assetMetaCache.get('active-single')).toBeUndefined()
    expect(result.current?.id).toBe('active-single')
    const pending = deferred()
    load.mockReturnValueOnce(pending.promise)
    rerender({ id: 'slow-single' })
    rerender({ id: 'new-single' })
    await waitFor(() => expect(result.current?.id).toBe('new-single'))
    await act(async () => pending.resolve(asset('slow-single')))
    expect(result.current?.id).toBe('new-single')
  })
})

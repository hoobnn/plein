import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { TexturePool, type TexturePoolOptions, TextureSlot } from './textures'

interface Sample {
  url: string
  bytes: number
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function setup(options: Partial<TexturePoolOptions<Sample>> = {}) {
  const load = vi.fn(async (url: string) => ({ url, bytes: 8 }))
  const unload = vi.fn(async (_url: string) => {})
  const pool = new TexturePool<Sample>({
    load,
    unload,
    estimateBytes: (texture) => texture.bytes,
    budgetBytes: 32,
    idleLimit: 2,
    idleMs: 1000,
    ...options,
  })
  return { pool, load, unload }
}

beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }))
afterEach(() => vi.useRealTimers())

describe('TexturePool', () => {
  it('shares one texture across owners and never evicts another owner’s lease', async () => {
    const { pool, load, unload } = setup()
    const first = pool.createOwner()
    const second = pool.createOwner()
    const a = first.acquire('/shared.webp')
    const b = second.acquire('http://localhost/shared.webp')
    expect(await a.promise).toBe(await b.promise)
    expect(load).toHaveBeenCalledTimes(1)
    expect(pool.stats.activeLeases).toBe(2)
    first.dispose()
    await flush()
    expect(unload).not.toHaveBeenCalled()
    expect(pool.stats.activeLeases).toBe(1)
    second.dispose()
    await flush()
    expect(unload).toHaveBeenCalledExactlyOnceWith('http://localhost/shared.webp')
    expect(pool.stats).toMatchObject({ owners: 0, activeLeases: 0, readyTextures: 0 })
    second.dispose()
    b.release()
    expect(unload).toHaveBeenCalledTimes(1)
  })

  it('retains warm previews until the idle deadline and reuses them without loading', async () => {
    const { pool, load, unload } = setup()
    const owner = pool.createOwner()
    const first = owner.acquire('/a')
    const texture = await first.promise
    first.release()
    await vi.advanceTimersByTimeAsync(999)
    expect(unload).not.toHaveBeenCalled()
    const second = owner.acquire('/a')
    expect(await second.promise).toBe(texture)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(unload).not.toHaveBeenCalled()
    second.release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(unload).toHaveBeenCalledTimes(1)
    owner.dispose()
  })

  it('evicts the least recently released idle texture when its count is exceeded', async () => {
    const { pool, unload } = setup({ idleLimit: 1 })
    const owner = pool.createOwner()
    const a = owner.acquire('/a')
    const b = owner.acquire('/b')
    await Promise.all([a.promise, b.promise])
    a.release()
    await vi.advanceTimersByTimeAsync(5)
    b.release()
    await flush()
    expect(unload).toHaveBeenCalledExactlyOnceWith('http://localhost/a')
    expect(pool.stats.idleTextures).toBe(1)
    owner.dispose()
    await flush()
  })

  it('reports pinned overflow but only evicts idle textures to meet its byte budget', async () => {
    const { pool, unload } = setup({ budgetBytes: 8 })
    const owner = pool.createOwner()
    const a = owner.acquire('/a')
    const b = owner.acquire('/b')
    await Promise.all([a.promise, b.promise])
    expect(pool.stats).toMatchObject({ pinnedEstimatedBytes: 16, pinnedOverBudgetBytes: 8 })
    expect(unload).not.toHaveBeenCalled()
    a.release()
    await flush()
    expect(unload).toHaveBeenCalledExactlyOnceWith('http://localhost/a')
    expect(pool.stats.estimatedTextureBytes).toBe(8)
    expect(pool.stats.pinnedOverBudgetBytes).toBe(0)
    owner.dispose()
    await flush()
  })

  it('cancels queued work and bounds concurrent loads without aborting a shared load', async () => {
    const pending = deferred<Sample>()
    const { pool } = setup({ concurrency: 1, load: () => pending.promise })
    const owner = pool.createOwner()
    const a = owner.acquire('/a')
    const b = owner.acquire('/b')
    await flush()
    expect(pool.stats).toMatchObject({ inFlightLoads: 1, queuedLoads: 1, loadsStarted: 1 })
    b.release()
    await expect(b.promise).rejects.toMatchObject({ name: 'AbortError' })
    const next = pool.createOwner()
    const shared = next.acquire('/a')
    owner.dispose()
    pending.resolve({ url: 'a', bytes: 8 })
    expect(await shared.promise).toEqual({ url: 'a', bytes: 8 })
    await a.promise
    expect(pool.stats.loadsStarted).toBe(1)
    next.dispose()
    await flush()
  })

  it('discards a late result after the last consumer is disposed', async () => {
    const pending = deferred<Sample>()
    const { pool, unload } = setup({ load: () => pending.promise })
    const owner = pool.createOwner()
    const lease = owner.acquire('/slow')
    await flush()
    owner.dispose()
    pending.resolve({ url: 'slow', bytes: 8 })
    await expect(lease.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flush()
    expect(unload).toHaveBeenCalledExactlyOnceWith('http://localhost/slow')
    expect(pool.stats).toMatchObject({ activeLeases: 0, inFlightLoads: 0, readyTextures: 0 })
  })

  it('waits for an old unload before loading the same URL again', async () => {
    const eviction = deferred<void>()
    const unload = vi.fn(() => eviction.promise)
    const { pool, load } = setup({ unload, idleLimit: 0 })
    const owner = pool.createOwner()
    const first = owner.acquire('/a')
    await first.promise
    first.release()
    await flush()
    const second = owner.acquire('/a')
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    eviction.resolve()
    await second.promise
    expect(load).toHaveBeenCalledTimes(2)
    owner.dispose()
    await flush()
  })

  it('removes failed entries so the next acquisition can retry', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ bytes: 8 })
    const { pool } = setup({ load })
    const owner = pool.createOwner()
    await expect(owner.acquire('/a').promise).rejects.toThrow('offline')
    expect(await owner.acquire('/a').promise).toEqual({ bytes: 8 })
    expect(load).toHaveBeenCalledTimes(2)
    expect(pool.stats.loadErrors).toBe(1)
    owner.dispose()
    await flush()
  })
})

describe('TextureSlot', () => {
  it('keeps the small preview during an upgrade and clears a different asset immediately', async () => {
    const large = deferred<Sample>()
    const stale = deferred<Sample>()
    const { pool } = setup({
      load: async (url) => {
        if (url.endsWith('/large')) return large.promise
        if (url.endsWith('/stale')) return stale.promise
        return { url, bytes: 8 }
      },
    })
    const owner = pool.createOwner()
    const slot = new TextureSlot(owner)
    const changed = vi.fn()
    slot.setSource('asset-a', '/small', changed)
    await flush()
    const small = slot.texture
    expect(small?.url).toContain('/small')
    slot.setSource('asset-a', '/large', changed)
    await flush()
    expect(slot.texture).toBe(small)
    large.resolve({ url: '/large', bytes: 16 })
    await flush()
    expect(slot.texture?.url).toBe('/large')
    slot.setSource('asset-a', '/stale', changed)
    await flush()
    slot.setSource('asset-b', '/new', changed)
    expect(slot.texture).toBeUndefined()
    await flush()
    stale.resolve({ url: '/stale', bytes: 8 })
    await flush()
    expect(slot.texture?.url).toContain('/new')
    expect(changed).toHaveBeenCalledTimes(3)
    slot.destroy()
    slot.destroy()
    owner.dispose()
    await flush()
    expect(pool.stats.activeLeases).toBe(0)
  })

  it('never presents a late result after destruction and retries a failed upgrade', async () => {
    const late = deferred<Sample>()
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ bytes: 8 })
      .mockImplementationOnce(() => late.promise)
    const { pool } = setup({ load })
    const owner = pool.createOwner()
    const slot = new TextureSlot(owner)
    const changed = vi.fn()
    slot.setSource('a', '/a', changed)
    await flush()
    slot.setSource('a', '/a', changed)
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    slot.setSource('b', '/late', changed)
    await flush()
    slot.destroy()
    late.resolve({ url: 'late', bytes: 8 })
    await flush()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(slot.texture).toBeUndefined()
    owner.dispose()
    await flush()
  })
})

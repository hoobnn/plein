import type { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import { openLocalCache, watchCacheWrites } from './localCache'

/** openLocalCache 的用例把 y-indexeddb 换成可注入的假实现：名字带 throw 时同步抛错 */
vi.mock('y-indexeddb', () => {
  class Fake {
    _db: Promise<unknown>
    constructor(name: string, _doc: Y.Doc) {
      if (name === 'plein-canvas:throw') throw new Error('blocked')
      this._db = (globalThis as { __failDb?: Promise<never> }).__failDb ?? Promise.resolve()
    }
  }
  return { IndexeddbPersistence: Fake }
})

function cache() {
  const transactions: Array<{
    oncomplete: (() => void) | null
    onabort: (() => void) | null
    onerror: (() => void) | null
  }> = []
  const local = {
    whenSynced: Promise.resolve(),
    db: {
      addEventListener: () => {},
      removeEventListener: () => {},
      transaction: () => {
        const tx = {
          objectStore: () => ({ count: () => {} }),
          oncomplete: null,
          onabort: null,
          onerror: null,
        }
        transactions.push(tx)
        return tx
      },
    },
  } as unknown as Pick<IndexeddbPersistence, 'whenSynced' | 'db'>
  return { local, transactions }
}

describe('本机缓存落盘确认', () => {
  it('等待事务完成才算已保存，新改动不接受旧事务的回执', async () => {
    const { local, transactions } = cache()
    const doc = new Y.Doc()
    const state = vi.fn()
    const stop = watchCacheWrites(doc, local, state)
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    expect(state).toHaveBeenLastCalledWith('saving')
    doc.getMap('meta').set('title', '新改动')
    transactions[0]!.oncomplete!()
    await vi.waitFor(() => expect(transactions).toHaveLength(2))
    expect(state).not.toHaveBeenCalledWith('saved')
    transactions[1]!.oncomplete!()
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('saved'))
    stop()
    doc.destroy()
  })

  it('事务失败后不把后续只读屏障误当成写入成功', async () => {
    const { local, transactions } = cache()
    const doc = new Y.Doc()
    const state = vi.fn()
    const stop = watchCacheWrites(doc, local, state)
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    transactions[0]!.onabort!()
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('failed'))
    doc.getMap('meta').set('title', '再改一次')
    await Promise.resolve()
    expect(state).not.toHaveBeenCalledWith('saved')
    expect(transactions).toHaveLength(1)
    stop()
    doc.destroy()
  })

  it('退订后晚回执不再改变画布状态', async () => {
    const { local, transactions } = cache()
    const doc = new Y.Doc()
    const state = vi.fn()
    const stop = watchCacheWrites(doc, local, state)
    await vi.waitFor(() => expect(transactions).toHaveLength(1))
    stop()
    state.mockClear()
    transactions[0]!.oncomplete!()
    await Promise.resolve()
    expect(state).not.toHaveBeenCalled()
    doc.destroy()
  })
})

describe('打开本地缓存', () => {
  it('IndexedDB 不可用时返回 null，照常等服务端同步', () => {
    const doc = new Y.Doc()
    const saved = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    try {
      expect(openLocalCache('c1', doc)).toBeNull()
    } finally {
      if (saved === undefined) vi.unstubAllGlobals()
      else vi.stubGlobal('indexedDB', saved)
      vi.unstubAllGlobals()
    }
    doc.destroy()
  })

  it('构造同步抛错时返回 null', () => {
    const doc = new Y.Doc()
    const saved = globalThis.indexedDB
    vi.stubGlobal('indexedDB', {})
    try {
      expect(openLocalCache('throw', doc)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
      if (saved !== undefined) vi.stubGlobal('indexedDB', saved)
    }
    doc.destroy()
  })

  it('缓存异步打开失败时回调，按没有缓存处理', async () => {
    const doc = new Y.Doc()
    const volatile = vi.fn()
    const saved = globalThis.indexedDB
    const failing = Promise.reject(new Error('denied'))
    vi.stubGlobal('indexedDB', {})
    ;(globalThis as { __failDb?: Promise<never> }).__failDb = failing
    try {
      const local = openLocalCache('c3', doc, volatile)
      expect(local).toBeTruthy()
      await expect((local as unknown as { _db: Promise<unknown> })._db).rejects.toThrow('denied')
      await Promise.resolve()
      expect(volatile).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as { __failDb?: Promise<never> }).__failDb
      vi.unstubAllGlobals()
      if (saved !== undefined) vi.stubGlobal('indexedDB', saved)
    }
    doc.destroy()
  })
})

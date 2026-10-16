import type { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import { watchCacheWrites } from './localCache'

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

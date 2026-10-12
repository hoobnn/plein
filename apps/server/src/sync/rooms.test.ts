import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { type Conn, type DocStore, Rooms } from './rooms'

function memoryStore(): DocStore & { data: Map<string, Uint8Array[]> } {
  const data = new Map<string, Uint8Array[]>()
  return {
    data,
    load: (id) => data.get(id) ?? [],
    append: (id, u) => data.set(id, [...(data.get(id) ?? []), u]),
    replace: (id, s) => data.set(id, [s]),
  }
}

const conn = (): Conn => ({ send() {}, close() {}, readOnly: false })

afterEach(() => vi.useRealTimers())

describe('房间生命周期', () => {
  it('持有租约时最后一个连接断开也不卸载，写入照常持久化', () => {
    vi.useFakeTimers()
    const store = memoryStore()
    const rooms = new Rooms(store)
    const c = conn()
    rooms.get('a').join(c)
    const lease = rooms.acquire('a')
    rooms.get('a').leave(c)
    vi.advanceTimersByTime(60_000)
    expect(rooms.has('a')).toBe(true)

    // 任务在标签页关闭很久之后才写回结果
    lease.room.doc.getMap('m').set('result', 1)
    lease.release()
    vi.advanceTimersByTime(60_000)
    expect(rooms.has('a')).toBe(false)

    const reloaded = new Y.Doc()
    for (const u of store.load('a')) Y.applyUpdate(reloaded, u)
    expect(reloaded.getMap('m').get('result')).toBe(1)
  })

  it('只被服务端短暂打开、从未有连接的房间也会卸载', () => {
    vi.useFakeTimers()
    const rooms = new Rooms(memoryStore())
    rooms.get('b')
    vi.advanceTimersByTime(60_000)
    expect(rooms.has('b')).toBe(false)
  })

  it('release 多次调用只释放一次', () => {
    vi.useFakeTimers()
    const rooms = new Rooms(memoryStore())
    const first = rooms.acquire('c')
    const second = rooms.acquire('c')
    first.release()
    first.release()
    vi.advanceTimersByTime(60_000)
    expect(rooms.has('c')).toBe(true)
    second.release()
    vi.advanceTimersByTime(60_000)
    expect(rooms.has('c')).toBe(false)
  })
})

import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import * as syncProtocol from 'y-protocols/sync'
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

/** 记下收到的消息和关闭码的连接 */
function recorder(readOnly = false) {
  const sent: Uint8Array[] = []
  const closed: number[] = []
  const c: Conn = { send: (d) => sent.push(d), close: (code) => closed.push(code ?? 0), readOnly }
  return { conn: c, sent, closed }
}

/** 存储里的增量重放成文档 */
function replay(store: DocStore, id: string) {
  const doc = new Y.Doc()
  for (const u of store.load(id)) Y.applyUpdate(doc, u)
  return doc
}

/** y-websocket 的同步消息 */
function syncMessage(write: (enc: encoding.Encoder) => void) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, 0)
  write(enc)
  return encoding.toUint8Array(enc)
}

/** 同步消息的子类型（step1 / step2 / update） */
function syncType(msg: Uint8Array) {
  const dec = decoding.createDecoder(msg)
  if (decoding.readVarUint(dec) !== 0) return null
  return decoding.readVarUint(dec)
}

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

    expect(replay(store, 'a').getMap('m').get('result')).toBe(1)
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

describe('写库合并', () => {
  it('短时间内的多条更新合并成一条写入，内容不丢', () => {
    vi.useFakeTimers()
    const store = memoryStore()
    const rooms = new Rooms(store)
    const { room, release } = rooms.acquire('d')
    const m = room.doc.getMap('m')
    for (let i = 0; i < 20; i++) m.set(`k${i}`, i)
    expect(store.load('d')).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(store.load('d')).toHaveLength(1)

    expect(replay(store, 'd').getMap('m').get('k19')).toBe(19)
    release()
  })

  it('卸载前还没写库的更新随快照落盘', () => {
    vi.useFakeTimers()
    const store = memoryStore()
    const rooms = new Rooms(store)
    const lease = rooms.acquire('e')
    lease.room.doc.getMap('m').set('x', 1)
    lease.release()
    rooms.unload('e')
    expect(rooms.has('e')).toBe(false)
    expect(replay(store, 'e').getMap('m').get('x')).toBe(1)
  })
})

describe('删除画布', () => {
  it('drop 后不能再打开，订阅者收到通知，连接以 4404 断开，之后的写入不落盘', () => {
    vi.useFakeTimers()
    const store = memoryStore()
    const rooms = new Rooms(store)
    const dropped: string[] = []
    rooms.onDrop((id) => dropped.push(id))
    const r = recorder()
    const lease = rooms.acquire('f')
    lease.room.join(r.conn)
    // 还在 50ms 缓冲里的更新随房间一起丢弃
    lease.room.doc.getMap('m').set('x', 1)
    rooms.drop('f')

    expect(dropped).toEqual(['f'])
    expect(r.closed).toEqual([4404])
    expect(rooms.has('f')).toBe(false)
    expect(() => rooms.get('f')).toThrow(/已删除/)
    // 残留任务还拿着旧文档写结果
    lease.room.doc.getMap('m').set('y', 2)
    lease.release()
    vi.advanceTimersByTime(60_000)
    expect(store.load('f')).toHaveLength(0)
  })
})

describe('关闭与卸载', () => {
  it('closeAll 把还在缓冲里的更新一起写进快照', () => {
    vi.useFakeTimers()
    const store = memoryStore()
    const rooms = new Rooms(store)
    rooms.acquire('g').room.doc.getMap('m').set('x', 1)
    expect(store.load('g')).toHaveLength(0)
    rooms.closeAll()
    expect(rooms.has('g')).toBe(false)
    expect(replay(store, 'g').getMap('m').get('x')).toBe(1)
  })

  it('等待卸载期间有连接加入：原计划取消，断开后重新计时', () => {
    vi.useFakeTimers()
    const rooms = new Rooms(memoryStore())
    const room = rooms.get('h')
    vi.advanceTimersByTime(20_000)
    const c = conn()
    room.join(c)
    vi.advanceTimersByTime(5_000)
    room.leave(c)
    // 距最初的计划已过 30 秒，但距断开才 10 秒
    vi.advanceTimersByTime(10_000)
    expect(rooms.has('h')).toBe(true)
    vi.advanceTimersByTime(30_000)
    expect(rooms.has('h')).toBe(false)
  })

  it('攒的增量超过 1MB 立即写库，不等定时器', () => {
    vi.useFakeTimers()
    const store = memoryStore()
    const rooms = new Rooms(store)
    const { room, release } = rooms.acquire('i')
    room.doc.getText('t').insert(0, 'x'.repeat((1 << 20) + 1))
    expect(store.load('i')).toHaveLength(1)
    release()
  })
})

describe('只读连接', () => {
  it('写入被忽略，拉取（step1）照常应答', () => {
    const rooms = new Rooms(memoryStore())
    const room = rooms.get('j')
    room.doc.getMap('m').set('server', 1)
    const r = recorder(true)
    room.join(r.conn)

    // 客户端带着自己的改动发来 update
    const client = new Y.Doc()
    client.getMap('m').set('client', 1)
    const update = Y.encodeStateAsUpdate(client)
    room.receive(
      r.conn,
      syncMessage((enc) => syncProtocol.writeUpdate(enc, update)),
    )
    expect(room.doc.getMap('m').get('client')).toBeUndefined()

    r.sent.length = 0
    room.receive(
      r.conn,
      syncMessage((enc) => syncProtocol.writeSyncStep1(enc, new Y.Doc())),
    )
    expect(r.sent.map(syncType)).toEqual([syncProtocol.messageYjsSyncStep2])
    rooms.closeAll()
  })
})

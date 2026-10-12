import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as Y from 'yjs'
import type { DB } from '../storage/db'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
/** 增量更新条数超过它就合并成一条 */
const COMPACT_AFTER = 500
/** 没有连接、也没有服务端租约后多久卸载文档 */
const UNLOAD_DELAY_MS = 30_000

/** 一个 WebSocket 连接；与具体的 WS 库解耦，便于测试 */
export interface Conn {
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
  readOnly: boolean
}

interface ConnState {
  /** 这个连接控制的 awareness clientID，断开时清掉 */
  clients: Set<number>
}

/**
 * 一个画布的协作房间：内存中的 Y.Doc + 连接 + awareness，增量写入 SQLite。
 * 协议与 y-websocket 客户端兼容（sync / awareness 两类消息）。
 */
export class Room {
  readonly doc = new Y.Doc({ gc: true })
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  private conns = new Map<Conn, ConnState>()
  /** 服务端代码（任务、整组运行）持有的租约数；有租约时不卸载 */
  private leases = 0
  private pending = 0
  private unloadTimer: NodeJS.Timeout | null = null

  constructor(
    readonly id: string,
    private store: DocStore,
    private onEmpty: (room: Room) => void,
  ) {
    for (const update of store.load(id)) Y.applyUpdate(this.doc, update, this)
    this.awareness.setLocalState(null)

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this) {
        store.append(id, update)
        if (++this.pending >= COMPACT_AFTER) this.compact()
      }
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this.broadcast(encoding.toUint8Array(enc))
    })

    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = [...added, ...updated, ...removed]
        const state = this.conns.get(origin as Conn)
        if (state) {
          for (const c of added) state.clients.add(c)
          for (const c of removed) state.clients.delete(c)
        }
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          enc,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        )
        this.broadcast(encoding.toUint8Array(enc))
      },
    )
  }

  get size() {
    return this.conns.size
  }

  /** 既没有连接也没有租约：可以卸载 */
  get idle() {
    return this.conns.size === 0 && this.leases === 0
  }

  join(conn: Conn) {
    this.cancelUnload()
    this.conns.set(conn, { clients: new Set() })
    // 先发 step1，客户端回 step2 补齐服务端缺的部分
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(enc, this.doc)
    conn.send(encoding.toUint8Array(enc))
    const states = this.awareness.getStates()
    if (states.size > 0) {
      const a = encoding.createEncoder()
      encoding.writeVarUint(a, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        a,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      )
      conn.send(encoding.toUint8Array(a))
    }
  }

  receive(conn: Conn, data: Uint8Array) {
    const decoder = decoding.createDecoder(data)
    const enc = encoding.createEncoder()
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      if (conn.readOnly) {
        // 只读连接只处理 step1（拉取），忽略任何写入
        if (decoding.readVarUint(decoder) === syncProtocol.messageYjsSyncStep1) {
          syncProtocol.readSyncStep1(decoder, enc, this.doc)
        }
      } else {
        syncProtocol.readSyncMessage(decoder, enc, this.doc, conn)
      }
      if (encoding.length(enc) > 1) conn.send(encoding.toUint8Array(enc))
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        conn,
      )
    }
  }

  leave(conn: Conn) {
    const state = this.conns.get(conn)
    if (!state) return
    this.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(this.awareness, [...state.clients], null)
    this.scheduleUnload()
  }

  retain() {
    this.leases++
    this.cancelUnload()
  }

  release() {
    this.leases = Math.max(0, this.leases - 1)
    this.scheduleUnload()
  }

  /** 空闲时安排卸载；连接或租约回来会取消 */
  scheduleUnload() {
    if (!this.idle || this.unloadTimer) return
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null
      this.onEmpty(this)
    }, UNLOAD_DELAY_MS)
    this.unloadTimer.unref?.()
  }

  private cancelUnload() {
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer)
      this.unloadTimer = null
    }
  }

  /** 把所有增量合并成一条快照 */
  compact() {
    this.store.replace(this.id, Y.encodeStateAsUpdate(this.doc))
    this.pending = 0
  }

  /** 关闭所有连接并释放（画布被删除或服务关闭） */
  close(code = 1001, reason = 'closing') {
    for (const conn of this.conns.keys()) conn.close(code, reason)
    this.conns.clear()
    if (this.unloadTimer) clearTimeout(this.unloadTimer)
    this.awareness.destroy()
    this.doc.destroy()
  }

  private broadcast(data: Uint8Array) {
    for (const conn of this.conns.keys()) conn.send(data)
  }
}

/** Yjs 更新的持久化 */
export interface DocStore {
  load(canvasId: string): Uint8Array[]
  append(canvasId: string, update: Uint8Array): void
  replace(canvasId: string, state: Uint8Array): void
}

export function sqliteDocStore(db: DB): DocStore {
  const select = db.prepare<[string], { data: Buffer }>(
    'SELECT data FROM doc_updates WHERE canvas_id = ? ORDER BY id',
  )
  const insert = db.prepare(
    'INSERT INTO doc_updates (canvas_id, data, created_at) VALUES (?, ?, ?)',
  )
  const clear = db.prepare('DELETE FROM doc_updates WHERE canvas_id = ?')
  const touch = db.prepare('UPDATE canvases SET updated_at = ? WHERE id = ?')
  const replace = db.transaction((id: string, state: Uint8Array) => {
    clear.run(id)
    insert.run(id, Buffer.from(state), Date.now())
  })
  return {
    load: (id) => select.all(id).map((r) => new Uint8Array(r.data)),
    append(id, update) {
      const now = Date.now()
      insert.run(id, Buffer.from(update), now)
      touch.run(now, id)
    },
    replace: (id, state) => replace(id, state),
  }
}

/** 一段时间内持有房间，期间不会被卸载；用完必须 release */
export interface RoomLease {
  room: Room
  release(): void
}

/**
 * 房间管理：按需加载，空闲（无连接、无租约）一段时间后合并并卸载。
 * 短暂读写用 get；跨 await 长时间持有文档（任务执行、整组运行）必须用 acquire，
 * 否则房间可能在中途被卸载，之后的写入不会持久化。
 */
export class Rooms {
  private rooms = new Map<string, Room>()

  constructor(private store: DocStore) {}

  get(id: string): Room {
    let room = this.rooms.get(id)
    if (!room) {
      room = new Room(id, this.store, (r) => this.unload(r.id))
      this.rooms.set(id, room)
      // 只被服务端代码短暂打开的房间也要能卸载
      room.scheduleUnload()
    }
    return room
  }

  acquire(id: string): RoomLease {
    const room = this.get(id)
    room.retain()
    let released = false
    return {
      room,
      release: () => {
        if (released) return
        released = true
        room.release()
      },
    }
  }

  has(id: string) {
    return this.rooms.has(id)
  }

  /** 画布被删除：断开连接，不再写入 */
  drop(id: string) {
    const room = this.rooms.get(id)
    if (!room) return
    this.rooms.delete(id)
    room.close(4404, 'canvas deleted')
  }

  unload(id: string) {
    const room = this.rooms.get(id)
    if (!room || !room.idle) return
    room.compact()
    this.rooms.delete(id)
    room.close()
  }

  /** 服务关闭前合并所有房间 */
  closeAll() {
    for (const room of this.rooms.values()) {
      room.compact()
      room.close()
    }
    this.rooms.clear()
  }
}

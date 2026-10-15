import { upgradeWebSocket } from '@hono/node-server'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Conn, Rooms } from './rooms'

/** 画布不存在或已删除：客户端据此清掉本机缓存（见 apps/web/src/canvas/CanvasView.tsx） */
const CLOSE_DELETED = 4404

/** Yjs 同步入口：/sync/<画布 id>，与 y-websocket 客户端兼容 */
export function syncRoutes(db: DB, rooms: Rooms) {
  return new Hono<AuthEnv>().get(
    '/sync/:room',
    upgradeWebSocket((c) => {
      const id = c.req.param('room')!
      const readOnly = c.var.principal.role === 'viewer'
      // 不存在（或已删除）的画布也先完成握手再以 4404 关闭：浏览器拿不到握手失败的 HTTP 状态，
      // 直接回 404 时客户端只会无限重连，带着本机缓存停在一张已经不存在的画布上
      const missing = !ownsCanvas(db, c.var.principal.id, id)
      let conn: Conn | null = null
      return {
        onOpen(_evt, ws) {
          if (missing) return ws.close(CLOSE_DELETED, 'canvas not found')
          conn = {
            readOnly,
            send(data) {
              if (ws.readyState === 1) ws.send(data as Uint8Array<ArrayBuffer>)
            },
            close: (code, reason) => ws.close(code, reason),
          }
          rooms.get(id).join(conn)
        },
        onMessage(evt, ws) {
          if (!conn || !(evt.data instanceof ArrayBuffer)) return
          // 画布在连接期间被删除时房间已不存在，不要再创建
          if (!rooms.has(id)) return ws.close(CLOSE_DELETED, 'canvas deleted')
          try {
            rooms.get(id).receive(conn, new Uint8Array(evt.data))
          } catch (err) {
            console.warn(`[sync] ${id} 消息处理失败：`, (err as Error).message)
            ws.close(1003, 'bad message')
          }
        },
        onClose() {
          if (conn && rooms.has(id)) rooms.get(id).leave(conn)
          conn = null
        },
      }
    }),
  )
}

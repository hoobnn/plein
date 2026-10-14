import { upgradeWebSocket } from '@hono/node-server'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Conn, Rooms } from './rooms'

/** Yjs 同步入口：/sync/<画布 id>，与 y-websocket 客户端兼容 */
export function syncRoutes(db: DB, rooms: Rooms) {
  return new Hono<AuthEnv>().get(
    '/sync/:room',
    async (c, next) => {
      if (!ownsCanvas(db, c.var.principal.id, c.req.param('room'))) {
        return c.json({ error: 'not_found', message: '画布不存在' }, 404)
      }
      await next()
    },
    upgradeWebSocket((c) => {
      const id = c.req.param('room')!
      const readOnly = c.var.principal.role === 'viewer'
      let conn: Conn | null = null
      return {
        onOpen(_evt, ws) {
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
          if (!rooms.has(id)) return ws.close(4404, 'canvas deleted')
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

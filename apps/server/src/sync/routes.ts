import { upgradeWebSocket } from '@hono/node-server'
import { SyncCheckRequest } from '@plein/protocol'
import { Hono } from 'hono'
import * as Y from 'yjs'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import { decodeSyncCredential, includesSnapshot } from './snapshot'
import type { Conn, Rooms } from './rooms'

/** 画布不存在或已删除：客户端据此清掉本机缓存（见 apps/web/src/canvas/CanvasView.tsx） */
const CLOSE_DELETED = 4404

/** Yjs 同步入口：/sync/<画布 id>，与 y-websocket 客户端兼容 */
export function syncRoutes(db: DB, rooms: Rooms) {
  return (
    new Hono<AuthEnv>()
      // 服务端是否已经收到浏览器这一版文档（含删除）：浏览器据此判断能否安全离开或提交
      .post('/api/canvases/:canvas/sync', async (c) => {
        const canvas = c.req.param('canvas')
        if (!ownsCanvas(db, c.var.principal.id, canvas))
          return c.json({ error: 'not_found', message: '画布不存在' }, 404)
        const body = SyncCheckRequest.safeParse(await c.req.json().catch(() => null))
        if (!body.success) return c.json({ error: 'invalid', message: '同步凭据格式无效' }, 400)
        const expected = decodeSyncCredential(body.data.expectSnapshot)
        if (!expected)
          return c.json(
            { error: 'sync_invalid', message: '本机文档的同步凭据无效，请刷新页面后重试' },
            409,
          )
        const room = rooms.get(canvas)
        if (!includesSnapshot(Y.snapshot(room.doc), expected))
          return c.json(
            { error: 'sync_pending', message: '本机改动还没有同步到服务端，请等同步完成后再操作' },
            409,
          )
        // 收到不等于保存下来：只有真正写进 SQLite 才能让浏览器离开页面
        if (!room.persistNow())
          return c.json(
            { error: 'sync_unsaved', message: '服务端还没能把改动保存下来，请稍后再试' },
            503,
          )
        return c.json({ included: true, persisted: true })
      })
      .get(
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
  )
}

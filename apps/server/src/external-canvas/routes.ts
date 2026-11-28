import {
  ExternalApply,
  ExternalProjectsRequest,
  ExternalSpacesRequest,
  ExternalPullNew,
  ExternalTarget,
  SyncCredential,
} from '@plein/protocol'
import { Hono } from 'hono'
import * as Y from 'yjs'
import { z } from 'zod'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import type { Rooms } from '../sync/rooms'
import { decodeSyncCredential, includesSnapshot } from '../sync/snapshot'
import { jimengCanvas } from './jimeng-canvas'
import { jimengNovel } from './jimeng-novel'
import type { ProjectQueue } from './project-queue'
import { externalService, SyncConflict } from './service'

export function externalCanvasRoutes(db: DB, rooms: Rooms, projectQueue: ProjectQueue) {
  const svc = externalService(
    db,
    rooms,
    {
      'jimeng-canvas': jimengCanvas,
      'jimeng-novel': jimengNovel,
    },
    projectQueue,
  )
  const app = new Hono<AuthEnv>()
  const base = '/api/canvases/:canvas/external' as const
  app.use(`${base}/*`, async (c, next) => {
    if (!ownsCanvas(db, c.var.principal.id, c.req.param('canvas')!))
      return c.json({ error: 'not_found', message: '画布不存在' }, 404)
    await next()
  })
  app.onError((err, c) => {
    const conflict = err instanceof SyncConflict
    const message =
      err instanceof z.ZodError || err instanceof SyntaxError
        ? 'CLI 返回的数据格式不兼容，请检查版本'
        : err.message
    return c.json(
      { error: conflict ? 'changed' : 'external_canvas_error', message },
      conflict ? 409 : 422,
    )
  })
  app.get(`${base}/targets`, (c) => c.json(svc.targets(c.req.param('canvas'))))
  app.post(`${base}/spaces`, async (c) => {
    const input = ExternalSpacesRequest.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'invalid', message: '空间查询参数无效' }, 400)
    return c.json(await svc.spaces(input.data.provider))
  })
  app.post(`${base}/projects`, async (c) => {
    const input = ExternalProjectsRequest.safeParse(await c.req.json().catch(() => null))
    if (!input.success)
      return c.json({ error: 'invalid', message: '项目查询参数无效，请重新选择空间' }, 400)
    return c.json(await svc.projects(input.data.provider, input.data.space))
  })
  for (const op of ['preview', 'pull-new', 'apply'] as const) {
    app.post(`${base}/${op}`, async (c) => {
      const id = c.req.param('canvas')
      const raw: unknown = await c.req.json().catch(() => null)
      const request = ExternalTarget.extend({
        expectSnapshot: SyncCredential.optional(),
      }).safeParse(raw)
      if (!request.success)
        return c.json({ error: 'invalid', message: '请选择平台并输入项目 ID' }, 400)
      if (request.data.expectSnapshot) {
        const expected = decodeSyncCredential(request.data.expectSnapshot)
        if (!expected || !includesSnapshot(Y.snapshot(rooms.get(id).doc), expected))
          throw new SyncConflict('画布改动尚未同步到 Plein 服务，请稍后刷新')
      }
      if (op === 'preview') return c.json(await svc.run(id, request.data))
      if (op === 'pull-new') {
        const batch = ExternalPullNew.safeParse(raw)
        if (!batch.success)
          return c.json({ error: 'invalid', message: '每批可导入 1 至 200 个节点' }, 400)
        await svc.run(id, request.data, batch.data)
        return c.json({ imported: batch.data.rows.length })
      }
      const apply = ExternalApply.safeParse(raw)
      if (!apply.success) return c.json({ error: 'invalid', message: '同步操作格式无效' }, 400)
      await svc.run(id, request.data, apply.data)
      return c.body(null, 204)
    })
  }
  return app
}

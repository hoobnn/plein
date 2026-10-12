import { GroupRunOptions, type JobList, type NodeRunStarted } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../http/canvases'
import { NodeRunError } from '../plugins/host'
import type { DB } from '../storage/db'
import type { NodeRuns } from './runs'

const STATUS: Record<string, 404 | 409 | 400> = {
  not_found: 404,
  not_installed: 404,
  busy: 409,
}

/** 节点运行接口：单节点开始 / 取消，整组运行 Frame */
export function runRoutes(db: DB, runs: NodeRuns) {
  const notFound = { error: 'not_found', message: '画布不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能运行节点' }

  return new Hono<AuthEnv>()
    .post('/api/canvases/:canvas/nodes/:node/run', (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      try {
        const runId = runs.start(canvas, node, p.id)
        return c.json({ runId } satisfies NodeRunStarted, 202)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .post('/api/canvases/:canvas/nodes/:node/cancel', (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      runs.cancel(canvas, node)
      return c.body(null, 204)
    })
    .get('/api/canvases/:canvas/jobs', (c) => {
      const canvas = c.req.param('canvas')
      if (!ownsCanvas(db, c.var.principal.id, canvas)) return c.json(notFound, 404)
      return c.json(runs.list(canvas) satisfies JobList)
    })
    .post('/api/canvases/:canvas/frames/:frame/run', async (c) => {
      const { canvas, frame } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = GroupRunOptions.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        return c.json(runs.runGroup(canvas, frame, p.id, body.data), 202)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .get('/api/runs/groups/:id', (c) => {
      const state = runs.groupState(c.req.param('id'), c.var.principal.id)
      return state ? c.json(state) : c.json({ error: 'not_found', message: '运行记录不存在' }, 404)
    })
    .post('/api/runs/groups/:id/cancel', (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      return runs.cancelGroup(c.req.param('id'), c.var.principal.id)
        ? c.body(null, 204)
        : c.json({ error: 'not_found', message: '运行记录不存在' }, 404)
    })
}

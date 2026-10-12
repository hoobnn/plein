import type { NodeRunStarted } from '@plein/protocol'
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

/** 节点运行接口：开始 / 取消 */
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
}

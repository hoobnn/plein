import {
  BatchRunOptions,
  CommitStoryboardBatch,
  StoryboardBatchRequest,
  FlowRunOptions,
  GroupRunOptions,
  type ImpactReport,
  ImpactRunOptions,
  type JobList,
  LatestNodeJobsOptions,
  KeepResults,
  type JobInfo,
  NodeRunOptions,
  NodeCancelOptions,
  type NodeRunStarted,
  type PreparedInput,
  RecoverJobOptions,
  type StaleNodes,
} from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../storage/canvases'
import { NodeRunError } from '../plugins/host'
import type { DB } from '../storage/db'
import { ImpactAnalyzer } from './impact'
import type { NodeRuns } from './runs'
import { StoryboardBatches } from './storyboard-batch'

const STATUS: Record<string, 404 | 409 | 400> = {
  not_found: 404,
  not_installed: 404,
  busy: 409,
  recovery_required: 409,
  run_changed: 409,
}

/** 节点运行接口：单节点开始 / 取消，整组运行 Frame */
export function runRoutes(db: DB, runs: NodeRuns) {
  const notFound = { error: 'not_found', message: '画布不存在' }
  const forbidden = { error: 'forbidden', message: '只读成员不能运行节点' }
  const impact = new ImpactAnalyzer(db, runs)
  const storyBatches = new StoryboardBatches(runs)

  return new Hono<AuthEnv>()
    .post('/api/canvases/:canvas/nodes/:node/storyboard-batch/preview', async (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = StoryboardBatchRequest.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: '清单参数不合法' }, 400)
      try {
        return c.json(await storyBatches.preview(canvas, node, p.id, body.data))
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .post('/api/canvases/:canvas/nodes/:node/storyboard-batch/commit', async (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = CommitStoryboardBatch.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: '清单确认参数不合法' }, 400)
      try {
        const result = await storyBatches.commit(canvas, node, p.id, body.data.token)
        if ('changed' in result)
          return c.json(
            {
              error: 'input_changed',
              message: '输入或任务已变化，请重新审阅清单',
              plan: result.changed,
            },
            409,
          )
        return c.json(result.started, 202)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .post('/api/canvases/:canvas/nodes/:node/run', async (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = NodeRunOptions.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        const r = await runs.startChecked(canvas, node, p.id, body.data.expect)
        if ('changed' in r)
          return c.json(
            {
              error: 'input_changed',
              message: '实际输入在预览后变了，请确认后再生成',
              input: r.changed,
            },
            409,
          )
        return c.json({ runId: r.runId } satisfies NodeRunStarted, 202)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .get('/api/canvases/:canvas/nodes/:node/input', async (c) => {
      const { canvas, node } = c.req.param()
      if (!ownsCanvas(db, c.var.principal.id, canvas)) return c.json(notFound, 404)
      try {
        return c.json(
          (await runs.preview(canvas, node, c.var.principal.id)) satisfies PreparedInput,
        )
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .post('/api/canvases/:canvas/nodes/:node/cancel', async (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const raw = await c.req.text()
      let input: unknown
      try {
        input = raw.trim() ? JSON.parse(raw) : {}
      } catch {
        return c.json({ error: 'invalid', message: '停止请求格式无效' }, 400)
      }
      const body = NodeCancelOptions.safeParse(input)
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        runs.cancel(canvas, node, body.data.runId)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
      return c.body(null, 204)
    })
    .post('/api/canvases/:canvas/nodes/:node/run-flow', async (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = FlowRunOptions.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        return c.json(runs.runFlow(canvas, node, p.id, body.data), 202)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .post('/api/canvases/:canvas/nodes/:node/run-batch', async (c) => {
      const { canvas, node } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = BatchRunOptions.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        return c.json(runs.runBatch(canvas, node, body.data.nodes, p.id), 202)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .get('/api/canvases/:canvas/stale', async (c) => {
      const canvas = c.req.param('canvas')
      if (!ownsCanvas(db, c.var.principal.id, canvas)) return c.json(notFound, 404)
      return c.json((await runs.staleNodes(canvas, c.var.principal.id)) satisfies StaleNodes)
    })
    .get('/api/canvases/:canvas/impact', async (c) => {
      const canvas = c.req.param('canvas')
      if (!ownsCanvas(db, c.var.principal.id, canvas)) return c.json(notFound, 404)
      return c.json((await impact.analyze(canvas, c.var.principal.id)) satisfies ImpactReport)
    })
    .post('/api/canvases/:canvas/impact/keep', async (c) => {
      const canvas = c.req.param('canvas')
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = KeepResults.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        const r = await impact.keep(canvas, p.id, body.data)
        if ('changed' in r)
          return c.json(
            {
              error: 'input_changed',
              message: '有节点的输入在查看后又变了，请重新查看影响',
              nodes: r.changed,
            },
            409,
          )
        return c.json(r.decisions, 201)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .delete('/api/canvases/:canvas/impact/keep/:id', (c) => {
      const { canvas, id } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      return runs.store.revokeDecision(canvas, id)
        ? c.body(null, 204)
        : c.json({ error: 'not_found', message: '保留记录不存在或已撤销' }, 404)
    })
    .post('/api/canvases/:canvas/impact/run', async (c) => {
      const canvas = c.req.param('canvas')
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = ImpactRunOptions.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        return c.json(runs.runImpact(canvas, p.id, body.data), 202)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
    })
    .get('/api/canvases/:canvas/jobs', (c) => {
      const canvas = c.req.param('canvas')
      if (!ownsCanvas(db, c.var.principal.id, canvas)) return c.json(notFound, 404)
      return c.json(runs.list(canvas) satisfies JobList)
    })
    .post('/api/canvases/:canvas/jobs/latest', async (c) => {
      const canvas = c.req.param('canvas')
      if (!ownsCanvas(db, c.var.principal.id, canvas)) return c.json(notFound, 404)
      const body = LatestNodeJobsOptions.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      return c.json(runs.latestForNodes(canvas, body.data.nodes))
    })
    .post('/api/canvases/:canvas/jobs/:job/recover', async (c) => {
      const { canvas, job } = c.req.param()
      const p = c.var.principal
      if (p.role === 'viewer') return c.json(forbidden, 403)
      if (!ownsCanvas(db, p.id, canvas)) return c.json(notFound, 404)
      const body = RecoverJobOptions.safeParse(await c.req.json().catch(() => ({})))
      if (!body.success) return c.json({ error: 'invalid', message: body.error.message }, 400)
      try {
        const r = runs.recoverJob(canvas, job, p.id, body.data)
        return r
          ? c.json(r satisfies JobInfo)
          : c.json({ error: 'not_found', message: '任务不存在' }, 404)
      } catch (err) {
        if (!(err instanceof NodeRunError)) throw err
        return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 400)
      }
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
    .get('/api/runs/groups/:id/items', (c) => {
      const items = runs.batchItems(c.req.param('id'), c.var.principal.id)
      return items ? c.json(items) : c.json({ error: 'not_found', message: '运行记录不存在' }, 404)
    })
    .post('/api/runs/groups/:id/cancel', (c) => {
      if (c.var.principal.role === 'viewer') return c.json(forbidden, 403)
      return runs.cancelGroup(c.req.param('id'), c.var.principal.id)
        ? c.body(null, 204)
        : c.json({ error: 'not_found', message: '运行记录不存在' }, 404)
    })
}

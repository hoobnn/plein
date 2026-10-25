import { API, type JobInfo, type JobList } from '@plein/protocol'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../app'
import type { AuthEnv } from '../auth'
import { canvases, jobs } from '../storage/schema'
import { addNode, bootServer, createCanvas, request } from '../testing'
import { runRoutes } from './routes'

afterEach(() => vi.restoreAllMocks())

function caller(server: Server, id: string, role: 'owner' | 'viewer' = 'owner') {
  return new Hono<AuthEnv>()
    .use('*', (c, next) => {
      c.set('principal', { id, role })
      return next()
    })
    .route('/', runRoutes(server.db, server.runs))
}
function seed(server: Server, id: string, canvasId: string, nodeId: string, ownerId = 'local') {
  server.runs.store.insert({ id, ownerId, canvasId, nodeId, nodeType: 'plein/image' })
  server.runs.store.update(id, { status: 'succeeded', attempts: 1, finished_at: Date.now() })
}

describe('按精确ID只读历史作业', () => {
  it('读取真实SQLite最新100条之外的作业，返回现成JobInfo且零submit/零画布或SQL写入', async () => {
    const { server } = await bootServer()
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '只读取历史证据' } })
    const input = await server.runs.preview(id, node, 'local')
    const oldId = 'historical-job'
    seed(server, oldId, id, node)
    server.runs.store.update(oldId, { input: JSON.stringify(input) })
    server.db.update(jobs).set({ created_at: 1 }).where(eq(jobs.id, oldId)).run()
    for (let i = 0; i < 105; i++) seed(server, `newer-job-${i}`, id, node)
    const recent = (await (await request(server, API.canvasJobs(id))).json()) as JobList
    expect(recent.jobs).toHaveLength(100)
    expect(recent.jobs.some((row) => row.id === oldId)).toBe(false)

    server.rooms.get(id).flush()
    const beforeRows = server.db.select().from(jobs).all()
    const beforeDoc = doc.ydoc.toJSON()
    const changes = () =>
      (server.db.$client.prepare('SELECT total_changes() AS count').get() as { count: number })
        .count
    const beforeChanges = changes()
    const updates = vi.fn()
    doc.ydoc.on('update', updates)
    const submit = vi.spyOn(server.plugins.registry.providers.get('plein/mock')!.def, 'submit')
    const start = vi.spyOn(server.runs, 'start')
    try {
      const response = await request(server, API.canvasJob(id, oldId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as JobInfo
      expect(body).toEqual(
        JSON.parse(JSON.stringify(server.runs.jobInfo(server.runs.store.get(oldId)!))),
      )
      expect(body).toMatchObject({
        id: oldId,
        nodeId: node,
        status: 'succeeded',
        attempts: 1,
        input,
      })
      expect(submit).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(updates).not.toHaveBeenCalled()
      expect(doc.ydoc.toJSON()).toEqual(beforeDoc)
      expect(server.db.select().from(jobs).all()).toEqual(beforeRows)
      expect(changes()).toBe(beforeChanges)
    } finally {
      doc.ydoc.off('update', updates)
    }
  })

  it('画布所有权、JobRow owner/canvas与存在性分别核对，范围不符统一404且不泄露任务', async () => {
    const { server } = await bootServer()
    const a = await createCanvas(server),
      b = await createCanvas(server),
      foreign = await createCanvas(server)
    const node = addNode(a.doc, 'plein/image')
    server.db.update(canvases).set({ owner_id: 'other' }).where(eq(canvases.id, foreign.id)).run()
    seed(server, 'own-job', a.id, node)
    seed(server, 'wrong-owner', a.id, node, 'other')
    seed(server, 'other-canvas', b.id, 'another-node')
    seed(server, 'foreign-job', foreign.id, 'foreign-node', 'other')
    const paths = [
      API.canvasJob(a.id, 'wrong-owner'),
      API.canvasJob(a.id, 'other-canvas'),
      API.canvasJob(foreign.id, 'foreign-job'),
      API.canvasJob('missing-canvas', 'own-job'),
      API.canvasJob(a.id, 'missing-job'),
      API.canvasJob('missing-canvas', 'missing-job'),
    ]
    for (const path of paths) {
      const response = await request(server, path)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found', message: '任务不存在' })
    }
    const other = caller(server, 'other')
    const denied = await other.request(API.canvasJob(a.id, 'own-job'))
    expect(denied.status).toBe(404)
    expect(await denied.json()).toEqual({ error: 'not_found', message: '任务不存在' })
    const allowed = await other.request(API.canvasJob(foreign.id, 'foreign-job'))
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ id: 'foreign-job', nodeId: 'foreign-node' })
  })

  it('viewer仍可读取自己的历史作业；不同owner拒绝，路径常量编码两个稳定身份', async () => {
    const { server } = await bootServer()
    const { id, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image')
    seed(server, 'view-job', id, node)
    seed(server, 'foreign-owner-job', id, node, 'other')
    const viewer = caller(server, 'local', 'viewer')
    const response = await viewer.request(API.canvasJob(id, 'view-job'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: 'view-job', nodeId: node })
    expect((await viewer.request(API.canvasJob(id, 'foreign-owner-job'))).status).toBe(404)
    expect((await viewer.request(API.nodeRun(id, node), { method: 'POST' })).status).toBe(403)
    expect(API.canvasJob('canvas /?#', 'job /?#')).toBe(
      '/api/canvases/canvas%20%2F%3F%23/jobs/job%20%2F%3F%23',
    )
  })
})

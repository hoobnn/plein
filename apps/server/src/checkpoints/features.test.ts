import { Readable } from 'node:stream'
import { existsSync } from 'node:fs'
import {
  addResults,
  createDoc,
  createElement,
  deleteElements,
  setParam,
  updateElement,
} from '@plein/doc'
import { Hono } from 'hono'
import * as Y from 'yjs'
import { describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, createCanvas, request, until } from '../testing'
import { createMediaIndex } from '../media-index/service'
import { mediaLibraryRoutes } from '../media-index/routes'
import { checkpointRoutes } from './routes'
import { createCheckpointService, includesSnapshot } from './service'
import { sqliteDocStore } from '../sync/rooms'
import { JobStore } from '../runs/store'
import { LibraryStore } from '../library/store'

async function setup() {
  const s = await bootServer()
  await until(() => s.server.mediaIndex.ready)
  const { id: canvasId, doc } = await createCanvas(s.server)
  const canvas = s.server.db.$client.prepare('SELECT * FROM canvases WHERE id=?').get(canvasId) as {
    project_id: string
  }
  const index = createMediaIndex({ db: s.server.db, rooms: s.server.rooms })
  index.install()
  await index.rebuild()
  onTestFinished(() => index.close())
  const checkpoints = createCheckpointService({
    db: s.server.db,
    rooms: s.server.rooms,
    assets: s.server.assets,
    index,
  })
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('principal', {
      id: c.req.header('x-owner') ?? 'local',
      role: c.req.header('x-viewer') ? 'viewer' : 'owner',
    })
    await next()
  })
  app.route('/', mediaLibraryRoutes(index))
  app.route('/', checkpointRoutes(checkpoints))
  const asset = async (name: string, owner = 'local') =>
    s.server.assets.ingest(
      owner,
      Readable.from([`<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`]),
      { mime: 'image/svg+xml', name },
    )
  const save = (name = '检查点') =>
    checkpoints.create('local', canvasId, {
      name,
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
  return { ...s, canvasId, projectId: canvas.project_id, doc, index, checkpoints, app, asset, save }
}

describe('跨画布素材检索', () => {
  it('删除来源投影失败不打断drop，房间释放且索引标incomplete，补建后去掉悬空来源', async () => {
    const s = await setup(),
      a = await s.asset('删除来源故障素材')
    createElement(s.doc, { kind: 'image', assetId: a.id, x: 0, y: 0, w: 10, h: 10 })
    const room = s.server.rooms.get(s.canvasId),
      closed = vi.fn()
    room.join({ readOnly: false, send() {}, close: closed })
    room.flush()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    onTestFinished(() => errors.mockRestore())
    s.server.db.$client.exec(
      "CREATE TRIGGER reject_deleted_projection BEFORE DELETE ON media_sources WHEN OLD.source_type='canvas' BEGIN SELECT RAISE(FAIL,'projection delete failure'); END",
    )
    s.server.db.$client.prepare('DELETE FROM canvases WHERE id=?').run(s.canvasId)
    expect(() => s.server.rooms.drop(s.canvasId)).not.toThrow()
    expect(s.server.rooms.has(s.canvasId)).toBe(false)
    expect(closed).toHaveBeenCalledWith(4404, 'canvas deleted')
    expect(s.index.ready).toBe(false)
    expect(s.server.mediaIndex.ready).toBe(false)
    expect(
      s.server.db.$client.prepare('SELECT completed_at FROM media_index_meta WHERE id=1').get(),
    ).toEqual({ completed_at: null })
    s.server.db.$client.exec('DROP TRIGGER reject_deleted_projection')
    await s.index.rebuild()
    expect(s.index.ready).toBe(true)
    expect(s.index.sources('local', a.id, { limit: 50 }).items).toEqual([])
    expect(s.server.assets.get('local', a.id)).not.toBeNull()
  })

  it('库投影故障不重复写canonical，检索标incomplete并退避补建，恢复后来源齐全', async () => {
    const s = await setup(),
      a = await s.asset('修复库素材')
    const library = new LibraryStore(s.server.db)
    const off = library.onChange((id) => s.index.refreshLibrarySafely(id))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repair = vi.spyOn(s.index, 'rebuild')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => {
      off()
      errors.mockRestore()
      vi.useRealTimers()
    })
    s.server.db.$client.exec(
      "CREATE TRIGGER reject_library_projection BEFORE INSERT ON media_sources WHEN NEW.source_type='library' BEGIN SELECT RAISE(FAIL,'projection failure'); END",
    )
    const item = library.create('local', {
      kind: 'character',
      name: '已保存角色',
      images: [{ slot: 'main', assetId: a.id }],
      projectId: s.projectId,
      description: '',
      tags: {},
      voice: null,
      video: null,
      models: [],
      profile: null,
    })
    expect(library.get('local', item.id)?.name).toBe('已保存角色')
    expect(library.list('local')).toHaveLength(1)
    expect(s.index.ready).toBe(false)
    expect(
      s.server.db.$client.prepare('SELECT completed_at FROM media_index_meta WHERE id=1').get(),
    ).toEqual({ completed_at: null })
    expect(() => s.index.list('local', { q: '', limit: 50 })).toThrow('正在建立素材索引')
    await vi.advanceTimersByTimeAsync(999)
    expect(repair).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(repair).toHaveBeenCalledTimes(1)
    await expect(repair.mock.results[0]!.value).rejects.toThrow('projection failure')
    await vi.advanceTimersByTimeAsync(1999)
    expect(repair).toHaveBeenCalledTimes(1)
    s.server.db.$client.exec('DROP TRIGGER reject_library_projection')
    await vi.advanceTimersByTimeAsync(1)
    expect(repair).toHaveBeenCalledTimes(2)
    await repair.mock.results[1]!.value
    expect(s.index.ready).toBe(true)
    expect(s.index.sources('local', a.id, { limit: 50 }).items).toEqual([
      expect.objectContaining({ type: 'library', id: item.id }),
    ])
  })

  it('任务journal已保存不受派生投影故障影响；关闭取消待修复timer且不再访问DB', async () => {
    const s = await setup(),
      a = await s.asset('任务修复素材')
    const jobs = new JobStore(s.server.db)
    const off = jobs.onChange((id) => s.index.refreshJobSafely(id))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => {
      off()
      errors.mockRestore()
      vi.useRealTimers()
    })
    jobs.insert({
      id: 'run_projection_failure',
      ownerId: 'local',
      canvasId: s.canvasId,
      nodeId: 'deleted_node',
      nodeType: 'plein/image',
    })
    s.server.db.$client.exec(
      "CREATE TRIGGER reject_job_projection BEFORE INSERT ON media_sources WHEN NEW.source_type='job' BEGIN SELECT RAISE(FAIL,'projection failure'); END",
    )
    jobs.journal('run_projection_failure').set('generate', {
      state: 'done',
      result: { outputs: [], assets: [{ assetId: a.id, kind: 'image' }] },
    })
    expect(JSON.parse(jobs.get('run_projection_failure')!.calls).generate.state).toBe('done')
    expect(s.index.ready).toBe(false)
    const repair = vi.spyOn(s.index, 'rebuild')
    s.index.close()
    s.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(repair).not.toHaveBeenCalled()
    expect(() => s.index.refreshJobSafely('run_projection_failure')).not.toThrow()
    expect(() => s.index.refreshLibrarySafely('deleted_library')).not.toThrow()
  })

  it('后台补建时仅检索不可用，关闭服务可取消补建，重启从未完成标记恢复', async () => {
    const s = await setup(),
      asset = await s.asset('后台素材')
    createElement(s.doc, { kind: 'image', assetId: asset.id, x: 0, y: 0, w: 10, h: 10 })
    s.server.rooms.get(s.canvasId).flush()
    const building = s.index.rebuild()
    expect(() => s.index.list('local', { q: '', limit: 50 })).toThrow('正在建立素材索引')
    expect((await request(s.server, `/api/projects/${s.projectId}`)).status).toBe(200)
    s.index.close()
    s.close()
    await expect(building).resolves.toBeUndefined()
    const reopened = await bootServer({ dataDir: s.dataDir })
    await until(() => reopened.server.mediaIndex.ready)
    expect(
      reopened.server.mediaIndex.list('local', { q: '', limit: 50 }).items.map((a) => a.id),
    ).toContain(asset.id)
  })
  it('Yjs落盘同步写来源，纯几何落盘跳过投影；投影失败时doc更新事务回滚', async () => {
    const s = await setup(),
      a = await s.asset('持久化素材')
    const node = createElement(s.doc, { kind: 'image', assetId: a.id, x: 0, y: 0, w: 10, h: 10 })
    s.server.rooms.get(s.canvasId).flush()
    expect(
      s.server.db.$client
        .prepare(
          "SELECT * FROM media_sources WHERE source_type='canvas' AND source_id=? AND asset_id=?",
        )
        .all(s.canvasId, a.id),
    ).toHaveLength(1)
    const refresh = vi.spyOn(s.server.mediaIndex, 'refreshCanvas')
    updateElement(s.doc, node, { x: 42, y: 64 })
    s.server.rooms.get(s.canvasId).flush()
    expect(refresh).not.toHaveBeenCalled()
    refresh.mockRestore()
    const before = s.server.db.$client
      .prepare('SELECT count(*) n FROM doc_updates WHERE canvas_id=?')
      .get(s.canvasId)
    const store = sqliteDocStore(s.server.db, (id) => s.index.refreshCanvas(id))
    s.server.db.$client.exec(
      "CREATE TRIGGER reject_media_projection BEFORE INSERT ON media_sources BEGIN SELECT RAISE(FAIL,'projection failure'); END",
    )
    expect(() => store.append(s.canvasId, Y.encodeStateAsUpdate(s.doc.ydoc))).toThrow(
      'projection failure',
    )
    expect(
      s.server.db.$client
        .prepare('SELECT count(*) n FROM doc_updates WHERE canvas_id=?')
        .get(s.canvasId),
    ).toEqual(before)
    expect(
      s.server.db.$client
        .prepare(
          "SELECT * FROM media_sources WHERE source_type='canvas' AND source_id=? AND asset_id=?",
        )
        .all(s.canvasId, a.id),
    ).toHaveLength(1)
    s.server.db.$client.exec('DROP TRIGGER reject_media_projection')
  })
  it('同一资产跨画布去重，按 owner 隔离，并在过滤后用稳定游标分页', async () => {
    const s = await setup(),
      a = await s.asset('角色A'),
      b = await s.asset('角色B')
    createElement(s.doc, { kind: 'image', assetId: a.id, name: '主角', x: 0, y: 0, w: 10, h: 10 })
    const second = await createCanvas(s.server)
    createElement(second.doc, { kind: 'image', assetId: a.id, x: 0, y: 0, w: 10, h: 10 })
    createElement(second.doc, { kind: 'image', assetId: b.id, x: 50, y: 0, w: 10, h: 10 })
    await s.asset('其他用户', 'other')
    const first = s.index.list('local', { q: '', limit: 1 })
    const next = s.index.list('local', { q: '', limit: 1, cursor: first.nextCursor! })
    expect(new Set([...first.items, ...next.items].map((r) => r.id))).toEqual(new Set([a.id, b.id]))
    expect(next.nextCursor).toBeNull()
    expect(
      s.index.sources('local', a.id, { limit: 50 }).items.filter((r) => r.type === 'canvas'),
    ).toHaveLength(2)
    expect(
      s.index.list('local', { projectId: s.projectId, q: '', limit: 50 }).items.map((r) => r.id),
    ).toEqual([a.id])
    expect(() => s.index.list('other', { projectId: s.projectId, q: '', limit: 50 })).toThrow(
      '项目不存在',
    )
    expect(() => s.index.list('other', { q: '', limit: 1, cursor: first.nextCursor! })).toThrow(
      '游标',
    )
  })

  it('节点删除后已完成任务的本地产物仍可查，删项目后保留全局资产并移除来源', async () => {
    const s = await setup(),
      a = await s.asset('晚到产物')
    const node = createElement(s.doc, {
      kind: 'node',
      nodeType: 'plein/image',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    s.server.db.$client
      .prepare(
        "INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,calls,created_at) VALUES('run_late','local',?,?,'plein/image','succeeded',?,?)",
      )
      .run(
        s.canvasId,
        node,
        JSON.stringify({
          generate: { state: 'done', result: { assets: [{ assetId: a.id, kind: 'image' }] } },
        }),
        Date.now(),
      )
    s.index.refreshJob('run_late')
    deleteElements(s.doc, [node])
    const found = s.index.list('local', { projectId: s.projectId, q: '', limit: 50 })
    expect(found.items.map((r) => r.id)).toContain(a.id)
    expect(found.items[0]!.sources[0]!.locatable).toBe(false)
    const removed = await request(s.server, `/api/projects/${s.projectId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    const remaining = s.index.list('local', { q: '', limit: 50 }).items.find((r) => r.id === a.id)!
    expect(remaining.sourceCount).toBe(0)
    expect(existsSync(s.server.assets.originalPath(a.id))).toBe(true)
  })

  it('补建包含旧文档、嵌套参数、库和任务，重新补建幂等且关键词按字面处理', async () => {
    const s = await setup(),
      a = await s.asset('参考_100%')
    const node = createElement(s.doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      params: { nested: { assetId: a.id } },
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    s.server.library.create('local', {
      kind: 'prop',
      name: '铁盒',
      images: [{ slot: 'main', assetId: a.id }],
      projectId: s.projectId,
      description: '',
      tags: {},
      voice: null,
      video: null,
      models: [],
      profile: null,
    })
    await s.index.rebuild()
    const first = s.index.sources('local', a.id, { limit: 50 }).items
    expect(first.some((r) => r.nodeId === node)).toBe(true)
    expect(first.some((r) => r.type === 'library')).toBe(true)
    await s.index.rebuild()
    expect(s.index.sources('local', a.id, { limit: 50 }).items).toEqual(first)
    expect(s.index.list('local', { q: '_100%', limit: 50 }).items).toHaveLength(1)
    expect(s.index.list('local', { q: '_200%', limit: 50 }).items).toHaveLength(0)
    expect(
      (await s.app.request(`/api/assets/${a.id}/sources`, { headers: { 'x-owner': 'other' } }))
        .status,
    ).toBe(404)
  })
})

describe('命名检查点', () => {
  it('同步屏障允许服务端额外更新，仍核对完整删除区间', () => {
    const client = new Y.Doc(),
      server = new Y.Doc()
    client.getMap('elements').set('local', '内容')
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    const expected = Y.decodeSnapshot(Y.encodeSnapshot(Y.snapshot(client)))
    server.getMap('elements').set('remote', '同时改动')
    expect(includesSnapshot(Y.snapshot(server), expected)).toBe(true)
    const partial = {
      sv: new Map([[1, 10]]),
      ds: { clients: new Map([[1, [{ clock: 2, len: 2 }]]]) },
    } as Y.Snapshot
    const entire = {
      sv: new Map([[1, 10]]),
      ds: { clients: new Map([[1, [{ clock: 2, len: 4 }]]]) },
    } as Y.Snapshot
    expect(includesSnapshot(partial, entire)).toBe(false)
    client.destroy()
    server.destroy()
  })
  it('纯删除的 state vector 不变，Snapshot 删除集屏障仍拒绝旧服务端状态', async () => {
    const s = await setup()
    const node = createElement(s.doc, { kind: 'image', x: 0, y: 0, w: 10, h: 10 })
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(s.doc.ydoc))
    const before = Y.encodeStateVector(client)
    client.getMap('elements').delete(node)
    expect(Y.encodeStateVector(client)).toEqual(before)
    const body = {
      name: '删除后',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(client))).toString('base64'),
    }
    const failed = await s.app.request(`/api/canvases/${s.canvasId}/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(failed.status).toBe(409)
    Y.applyUpdate(s.doc.ydoc, Y.encodeStateAsUpdate(client))
    const cp = s.checkpoints.create('local', s.canvasId, body)
    const preview = createDoc()
    Y.applyUpdate(preview.ydoc, Buffer.from(s.checkpoints.detail('local', cp.id).state, 'base64'))
    expect(preview.has(node)).toBe(false)
    preview.destroy()
    client.destroy()
  })

  it('检查点冻结所有候选并pin；恢复为独立画布，仅终态历史、内部关联和新runId保留', async () => {
    const s = await setup(),
      a = await s.asset('候选A'),
      b = await s.asset('候选B')
    const node = createElement(s.doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: '原始版本' },
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    addResults(s.doc, node, [
      {
        id: 'result_a',
        port: 'images',
        value: { type: 'image', assetId: a.id },
        runId: 'run_a',
        at: 1,
      },
      {
        id: 'result_b',
        port: 'images',
        value: { type: 'image', assetId: b.id },
        runId: 'run_b',
        at: 2,
      },
    ])
    s.doc.mutable(node)!.set('run', { id: 'run_active', status: 'running', at: 3 })
    for (const run of ['run_a', 'run_b'])
      s.server.db.$client
        .prepare(
          "INSERT INTO jobs(id,owner_id,canvas_id,node_id,node_type,status,calls,created_at,cache_key) VALUES(?,'local',?,?,'plein/image','succeeded',?,1,'cache')",
        )
        .run(
          run,
          s.canvasId,
          node,
          JSON.stringify({ generate: { state: 'pending', remoteId: 'secret_remote' } }),
        )
    const cp = s.save('审核通过')
    setParam(s.doc, node, 'prompt', '保存后的修改')
    const pins = s.server.db.$client
      .prepare('SELECT * FROM checkpoint_assets WHERE checkpoint_id=?')
      .all(cp.id)
    expect(pins).toHaveLength(2)
    const restored = s.checkpoints.restore('local', cp.id)
    expect(restored.canvasId).not.toBe(s.canvasId)
    const doc = createDoc(s.server.rooms.get(restored.canvasId).doc)
    expect(doc.get(node)?.params?.prompt).toBe('原始版本')
    expect(doc.get(node)?.run).toBeUndefined()
    expect(doc.get(node)?.results).toHaveLength(2)
    expect(doc.get(node)?.results?.every((r) => r.runId !== 'run_a' && r.runId !== 'run_b')).toBe(
      true,
    )
    const restoredJobs = s.server.db.$client
      .prepare('SELECT * FROM jobs WHERE canvas_id=?')
      .all(restored.canvasId) as Array<Record<string, unknown>>
    expect(restoredJobs).toHaveLength(2)
    expect(
      restoredJobs.every(
        (r) =>
          r.status === 'succeeded' && r.calls === '{}' && r.frozen === null && r.group_id === null,
      ),
    ).toBe(true)
    expect(s.doc.get(node)?.run?.id).toBe('run_active')
    s.checkpoints.remove('local', cp.id)
    expect(
      s.server.db.$client
        .prepare('SELECT * FROM checkpoint_assets WHERE checkpoint_id=?')
        .all(cp.id),
    ).toHaveLength(0)
    expect(existsSync(s.server.assets.originalPath(a.id))).toBe(true)
    doc.destroy()
  })

  it('来源画布删除后检查点仍在项目；owner与viewer不能越权，删项目级联清理pin', async () => {
    const s = await setup(),
      a = await s.asset('独有素材')
    createElement(s.doc, { kind: 'image', assetId: a.id, x: 0, y: 0, w: 10, h: 10 })
    const cp = s.save()
    expect(
      (await s.app.request(`/api/checkpoints/${cp.id}`, { headers: { 'x-owner': 'other' } }))
        .status,
    ).toBe(404)
    expect(
      (
        await s.app.request(`/api/checkpoints/${cp.id}/restore`, {
          method: 'POST',
          headers: { 'x-viewer': '1' },
        })
      ).status,
    ).toBe(403)
    await request(s.server, `/api/canvases/${s.canvasId}`, { method: 'DELETE' })
    expect(
      s.checkpoints.list('local', s.projectId, { limit: 50 }).items[0]?.sourceCanvasId,
    ).toBeNull()
    expect(s.checkpoints.restore('local', cp.id).canvasId).toBeTruthy()
    expect(
      s.index.list('local', { projectId: s.projectId, q: '', limit: 50 }).items.map((r) => r.id),
    ).toContain(a.id)
    await request(s.server, `/api/projects/${s.projectId}`, { method: 'DELETE' })
    expect(s.server.db.$client.prepare('SELECT * FROM checkpoint_assets').all()).toHaveLength(0)
    expect(
      s.index.list('local', { q: '', limit: 50 }).items.find((r) => r.id === a.id)?.sourceCount,
    ).toBe(0)
  })
})

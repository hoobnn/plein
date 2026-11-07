import { createElement, currentResult } from '@plein/doc'
import type { Canvas, Project } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'
import { CanvasOpError, duplicateCanvas, moveCanvasTo } from './duplicate'

async function call<T>(server: Server, path: string, method = 'GET', body?: unknown) {
  const res = await request(server, path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
}

async function seed() {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const { body: canvas } = await call<Canvas>(server, `/api/canvases/${id}`)
  await call(server, `/api/canvases/${id}`, 'PATCH', { title: '原画布' })
  createElement(doc, { kind: 'image', assetId: 'a'.repeat(64), x: 0, y: 0, w: 16, h: 16 })
  const gen = addNode(doc, 'plein/image', {
    params: { prompt: '天台', model: 'plein/mock:image' },
    x: 300,
  })
  server.runs.start(id, gen, 'local')
  await until(() => {
    const s = server.rooms.withDoc(id, (d) => d.get(gen)?.run?.status)
    return s === 'succeeded' || s === 'failed'
  }, 30_000)
  return { server, id, doc, gen, projectId: canvas.projectId }
}

const elementIds = (server: Server, id: string) =>
  server.rooms.withDoc(id, (d) => [...d.elementMaps.keys()].sort())

describe('复制画布', () => {
  it('复制出完整内容和结果，运行记录换新 id，原画布不受影响', async () => {
    const s = await seed()
    const before = Y.encodeStateAsUpdate(s.server.rooms.get(s.id).doc)
    const { status, body: copy } = await call<Canvas>(
      s.server,
      `/api/canvases/${s.id}/duplicate`,
      'POST',
      {},
    )
    expect(status).toBe(201)
    expect(copy.title).toBe('原画布 副本')
    expect(copy.projectId).toBe(s.projectId)
    expect(copy.id).not.toBe(s.id)
    expect(elementIds(s.server, copy.id)).toEqual(elementIds(s.server, s.id))

    // 新画布读得到已有结果，且结果指向复制出来的运行记录
    const origin = s.server.rooms.withDoc(s.id, (d) => currentResult(d.get(s.gen)!))
    const dup = s.server.rooms.withDoc(copy.id, (d) => currentResult(d.get(s.gen)!))
    expect(origin).toBeTruthy()
    expect(dup).toMatchObject({ value: origin!.value })
    expect(dup!.runId).not.toBe(origin!.runId)
    const jobRows = s.server.db.$client
      .prepare('SELECT id,canvas_id,status FROM jobs WHERE id IN (?,?)')
      .all(origin!.runId, dup!.runId) as Array<{ id: string; canvas_id: string; status: string }>
    expect(jobRows.find((r) => r.id === dup!.runId)).toMatchObject({
      canvas_id: copy.id,
      status: 'succeeded',
    })
    expect(jobRows.find((r) => r.id === origin!.runId)?.canvas_id).toBe(s.id)

    // 原画布没被改动
    expect(Y.encodeStateAsUpdate(s.server.rooms.get(s.id).doc)).toEqual(before)

    // 副本改动不回写原画布；副本里的节点能继续运行
    s.server.runs.start(copy.id, s.gen, 'local')
    await until(() => {
      const r = s.server.rooms.withDoc(copy.id, (d) => d.get(s.gen)?.results?.length)
      return r === 2
    }, 30_000)
    expect(s.server.rooms.withDoc(s.id, (d) => d.get(s.gen)?.results?.length)).toBe(1)
  })

  it('可指定标题和目标项目，不复制检查点', async () => {
    const s = await seed()
    const { body: other } = await call<Project>(s.server, '/api/projects', 'POST', { title: '乙' })
    const { body: copy } = await call<Canvas>(s.server, `/api/canvases/${s.id}/duplicate`, 'POST', {
      title: '备份',
      projectId: other.id,
    })
    expect(copy).toMatchObject({ title: '备份', projectId: other.id })
    const cps = s.server.db.$client
      .prepare('SELECT COUNT(*) n FROM canvas_checkpoints WHERE source_canvas_id=?')
      .get(copy.id) as { n: number }
    expect(cps.n).toBe(0)
    const { body: list } = await call<Canvas[]>(s.server, `/api/canvases?projectId=${other.id}`)
    expect(list.map((c) => c.id)).toContain(copy.id)
  })

  it('画布或项目不存在返回 404；别的所有者看不到画布也不能当目标项目', async () => {
    const s = await seed()
    expect((await call(s.server, '/api/canvases/cv_nope/duplicate', 'POST', {})).status).toBe(404)
    expect(
      (await call(s.server, `/api/canvases/${s.id}/duplicate`, 'POST', { projectId: 'pj_nope' }))
        .status,
    ).toBe(404)
    const deps = { db: s.server.db, rooms: s.server.rooms }
    expect(() => duplicateCanvas(deps, 'someone-else', s.id, {})).toThrow(CanvasOpError)
    // 目标项目属于另一所有者：本地所有者复制到它里面也被拒绝
    s.server.db.$client
      .prepare(
        "INSERT INTO projects(id,owner_id,title,created_at,updated_at) VALUES('pj_foreign','someone-else','别人的',1,1)",
      )
      .run()
    expect(
      (await call(s.server, `/api/canvases/${s.id}/duplicate`, 'POST', { projectId: 'pj_foreign' }))
        .status,
    ).toBe(404)
    expect(() => moveCanvasTo(deps, 'local', s.id, 'pj_foreign')).toThrow(CanvasOpError)
  })
})

describe('移动画布', () => {
  it('PATCH projectId 移到另一个项目，内容与运行记录不变，目标项目校验', async () => {
    const s = await seed()
    const { body: other } = await call<Project>(s.server, '/api/projects', 'POST', { title: '乙' })
    const before = Y.encodeStateAsUpdate(s.server.rooms.get(s.id).doc)
    const moved = await call<Canvas>(s.server, `/api/canvases/${s.id}`, 'PATCH', {
      projectId: other.id,
    })
    expect(moved.status).toBe(200)
    expect(moved.body).toMatchObject({ id: s.id, projectId: other.id, title: '原画布' })
    expect(Y.encodeStateAsUpdate(s.server.rooms.get(s.id).doc)).toEqual(before)
    const { body: project } = await call<Project>(s.server, `/api/projects/${other.id}`)
    expect(
      (await call<Canvas[]>(s.server, `/api/projects/${other.id}/canvases`)).body.map((c) => c.id),
    ).toContain(s.id)
    expect(project.canvases).toBe(2)
    const { body: old } = await call<Project>(s.server, `/api/projects/${s.projectId}`)
    expect(old.canvases).toBe(0)

    // 失败时标题也不改
    const bad = await call(s.server, `/api/canvases/${s.id}`, 'PATCH', {
      title: '不该生效',
      projectId: 'pj_nope',
    })
    expect(bad.status).toBe(404)
    expect((await call<Canvas>(s.server, `/api/canvases/${s.id}`)).body.title).toBe('原画布')
    // 只改标题仍可用；什么都不给是 400
    expect(
      (await call<Canvas>(s.server, `/api/canvases/${s.id}`, 'PATCH', { title: '新名' })).body
        .title,
    ).toBe('新名')
    expect((await call(s.server, `/api/canvases/${s.id}`, 'PATCH', {})).status).toBe(400)
    expect(
      (await call(s.server, '/api/canvases/cv_nope', 'PATCH', { projectId: other.id })).status,
    ).toBe(404)
  })

  it('媒体索引里的画布来源跟着换项目', async () => {
    const s = await seed()
    const { body: other } = await call<Project>(s.server, '/api/projects', 'POST', { title: '乙' })
    await call(s.server, `/api/canvases/${s.id}`, 'PATCH', { projectId: other.id })
    const rows = s.server.db.$client
      .prepare('SELECT DISTINCT project_id FROM media_sources WHERE canvas_id=?')
      .all(s.id) as Array<{ project_id: string }>
    expect(rows.every((r) => r.project_id === other.id)).toBe(true)
  })
})

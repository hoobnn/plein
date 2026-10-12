import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createDoc, createElement, type PleinDoc, setParams } from '@plein/doc'
import { mockProvider } from '@plein/providers'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../app'
import { loadConfig } from '../config'

const dirs: string[] = []
const servers: Server[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  vi.restoreAllMocks()
})

const textPorts = { inputs: [], outputs: [{ id: 'text', label: '文本', type: 'text' as const }] }
const imagePorts = {
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' as const, multiple: true },
    { id: 'references', label: '参考图', type: 'image' as const, multiple: true },
  ],
  outputs: [{ id: 'images', label: '图片', type: 'image' as const }],
}
const videoPorts = {
  inputs: [
    { id: 'prompt', label: '提示词', type: 'text' as const, multiple: true },
    { id: 'firstFrame', label: '首帧', type: 'image' as const },
  ],
  outputs: [{ id: 'video', label: '视频', type: 'video' as const }],
}

async function boot(dataDir = mkdtempSync(join(tmpdir(), 'plein-jobs-')), env = {}) {
  if (!dirs.includes(dataDir)) dirs.push(dataDir)
  const server = await createServer({
    ...loadConfig({ PLEIN_DATA_DIR: dataDir, PLEIN_MOCK_PROVIDER: '1', ...env }),
    webDist: null,
  })
  servers.push(server)
  return { server, dataDir }
}

function mock(server: Server, settings: { latencyMs?: number; failWith?: string }) {
  server.plugins.configs.update('plein/mock', {
    settings: { latencyMs: 0, failWith: 'none', ...settings },
  })
}

/** 直接调 Hono 应用；免认证模式要求 Host 是本机名 */
function call(server: Server, path: string, init: RequestInit = {}) {
  return server.app.request(path, { ...init, headers: { host: '127.0.0.1:8787' } })
}

async function canvas(server: Server) {
  const res = await call(server, '/api/canvases', { method: 'POST', body: '{}' })
  const { id } = (await res.json()) as { id: string }
  return { id, doc: createDoc(server.rooms.get(id).doc, { schedule: () => {} }) }
}

const at = (x: number) => ({ x, y: 0, w: 200, h: 200 })

/** Frame：文本 → 图片 A → 图片 B，另有一个视频节点 */
function chain(doc: PleinDoc) {
  const frame = createElement(doc, { kind: 'frame', x: -50, y: -50, w: 1400, h: 400 })
  const opts = { parentId: frame }
  const text = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/text',
    nodeVersion: 1,
    params: { text: '天台 夜景' },
    ports: textPorts,
    ...at(0),
    ...opts,
  })
  const a = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    nodeVersion: 1,
    ports: imagePorts,
    ...at(300),
    ...opts,
  })
  const b = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    nodeVersion: 1,
    params: { prompt: '换个角度' },
    ports: imagePorts,
    ...at(600),
    ...opts,
  })
  const video = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    nodeVersion: 1,
    params: { prompt: '镜头推近' },
    ports: videoPorts,
    ...at(900),
    ...opts,
  })
  connect(doc, [text, 'text'], [a, 'prompt'])
  connect(doc, [a, 'images'], [b, 'references'])
  connect(doc, [b, 'images'], [video, 'firstFrame'])
  return { frame, text, a, b, video }
}

async function until<T>(fn: () => T | undefined | false, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function runFrame(server: Server, canvasId: string, frame: string, body = {}) {
  const res = await call(server, `/api/canvases/${canvasId}/frames/${frame}/run`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(202)
  const { groupId, total } = (await res.json()) as { groupId: string; total: number }
  const state = await until(() => {
    const s = server.runs.groupState(groupId, 'local')
    return s?.status !== 'running' && s
  })
  return { groupId, total, status: state!.status, summary: state!.summary! }
}

describe('任务队列', () => {
  it('超过并发上限的任务排队，前一个结束后再开始', async () => {
    const { server } = await boot(undefined, { PLEIN_MAX_JOBS: '1' })
    mock(server, { latencyMs: 300 })
    const { id, doc } = await canvas(server)
    const a = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: 'a' },
      ports: imagePorts,
      ...at(0),
    })
    const b = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: 'b' },
      ports: imagePorts,
      ...at(300),
    })
    const ra = server.runs.start(id, a, 'local')
    server.runs.start(id, b, 'local')
    await until(() => doc.get(a)?.run?.status === 'running')
    expect(doc.get(b)?.run?.status).toBe('queued')
    expect(server.runs.store.get(ra)?.status).toBe('running')
    await until(() => doc.get(b)?.run?.status === 'running')
    expect(doc.get(a)?.run?.status).toBe('succeeded')
    await until(() => doc.get(b)?.run?.status === 'succeeded')
  })

  it('取消排队中的任务', async () => {
    const { server } = await boot(undefined, { PLEIN_MAX_JOBS: '1' })
    mock(server, { latencyMs: 300 })
    const { id, doc } = await canvas(server)
    const a = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: 'a' },
      ports: imagePorts,
      ...at(0),
    })
    const b = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: 'b' },
      ports: imagePorts,
      ...at(300),
    })
    server.runs.start(id, a, 'local')
    const rb = server.runs.start(id, b, 'local')
    server.runs.cancel(id, b)
    expect(doc.get(b)?.run?.status).toBe('canceled')
    expect(server.runs.store.get(rb)?.status).toBe('canceled')
    await until(() => doc.get(a)?.run?.status === 'succeeded')
    expect(doc.get(b)?.run?.status).toBe('canceled')
  })

  it('限流等可重试的错误自动重试，平台恢复后成功', async () => {
    const { server } = await boot()
    // 第一次提交限流，之后恢复
    let calls = 0
    const submit = mockProvider.submit
    vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
      if (calls++ === 0) {
        const { ProviderError } = await import('@plein/plugin-sdk')
        throw new ProviderError('rate_limit', '模拟限流')
      }
      return submit(req, ctx)
    })
    ;(server.runs as unknown as { retryDelays: number[] }).retryDelays = [50, 50]
    const { id, doc } = await canvas(server)
    const a = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: 'a' },
      ports: imagePorts,
      ...at(0),
    })
    const run = server.runs.start(id, a, 'local')
    await until(() => doc.get(a)?.run?.message?.includes('重试'))
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(server.runs.store.get(run)?.attempts).toBe(2)
  })

  it('不可重试的错误直接失败', async () => {
    const { server } = await boot()
    mock(server, { failWith: 'content_policy' })
    const { id, doc } = await canvas(server)
    const a = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: 'a' },
      ports: imagePorts,
      ...at(0),
    })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect(server.runs.store.get(run)).toMatchObject({ attempts: 1, status: 'failed' })
    expect(doc.get(a)?.run?.error).toContain('content_policy')
  })

  it('服务重启后接着轮询远端任务，不重复提交', async () => {
    const first = await boot()
    mock(first.server, { latencyMs: 600 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const { id, doc } = await canvas(first.server)
    const a = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: 'a', count: 1 },
      ports: imagePorts,
      ...at(0),
    })
    const run = first.server.runs.start(id, a, 'local')
    await until(() => first.server.runs.store.get(run)?.calls.includes('pending'))
    expect(submit).toHaveBeenCalledTimes(1)
    // 退出：任务保持“运行中”，调用记录保留
    servers.splice(servers.indexOf(first.server), 1)
    first.server.close()

    const second = await boot(first.dataDir)
    const doc2 = createDoc(second.server.rooms.get(id).doc, { schedule: () => {} })
    expect(await second.server.runs.wait(run)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc2.get(a)?.results).toHaveLength(1)
    expect(doc2.get(a)?.run?.status).toBe('succeeded')
  })
})

describe('整组运行', () => {
  it('按依赖运行；没改动的节点命中缓存；改了上游后下游一起重跑；可强制重跑', async () => {
    const { server } = await boot()
    const { id, doc } = await canvas(server)
    const { frame, text, a, b, video } = chain(doc)

    const first = await runFrame(server, id, frame)
    // 视频节点默认不跑，文本节点不调模型不算
    expect(first.total).toBe(2)
    expect(first.summary).toMatchObject({ succeeded: 2, cached: 0, failed: 0, skipped: 0 })
    expect(doc.get(b)?.results?.length).toBeGreaterThan(0)
    expect(doc.get(video)?.run).toBeUndefined()
    const bResults = doc.get(b)!.results!.length

    const again = await runFrame(server, id, frame)
    expect(again.summary).toMatchObject({ succeeded: 0, cached: 2 })
    expect(doc.get(b)!.results!.length).toBe(bResults)

    // 改文本：A 的输入变了，A 重跑产生新结果，B 的参考图随之变化也重跑
    setParams(doc, text, { text: '天台 清晨' })
    const changed = await runFrame(server, id, frame)
    expect(changed.summary).toMatchObject({ succeeded: 2, cached: 0 })

    const forced = await runFrame(server, id, frame, { force: true, video: true })
    expect(forced.total).toBe(3)
    expect(doc.get(video)?.run?.error).toBeUndefined()
    expect(forced.summary).toMatchObject({ succeeded: 3, cached: 0 })
    expect(doc.get(video)?.run?.status).toBe('succeeded')
    expect(doc.get(a)!.results!.length).toBeGreaterThan(1)
  })

  it('上游失败时下游跳过', async () => {
    const { server } = await boot()
    mock(server, { failWith: 'content_policy' })
    const { id, doc } = await canvas(server)
    const { frame, b } = chain(doc)
    const r = await runFrame(server, id, frame)
    expect(r.summary).toMatchObject({ failed: 1, skipped: 1, succeeded: 0 })
    expect(doc.get(b)?.run).toBeUndefined()
  })

  it('取消整组：正在跑的取消，下游不再开始', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 2000 })
    const { id, doc } = await canvas(server)
    const { frame, a, b } = chain(doc)
    const res = await call(server, `/api/canvases/${id}/frames/${frame}/run`, {
      method: 'POST',
      body: '{}',
    })
    const { groupId } = (await res.json()) as { groupId: string }
    await until(() => doc.get(a)?.run?.status === 'running')
    const cancel = await call(server, `/api/runs/groups/${groupId}/cancel`, {
      method: 'POST',
    })
    expect(cancel.status).toBe(204)
    const state = await until(() => {
      const s = server.runs.groupState(groupId, 'local')
      return s?.status !== 'running' && s
    })
    expect(state).toMatchObject({ status: 'canceled', summary: { canceled: 1, skipped: 1 } })
    expect(doc.get(a)?.run?.status).toBe('canceled')
    expect(doc.get(b)?.run).toBeUndefined()
  })

  it('Frame 不存在时 404', async () => {
    const { server } = await boot()
    const { id } = await canvas(server)
    const res = await call(server, `/api/canvases/${id}/frames/nope/run`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})

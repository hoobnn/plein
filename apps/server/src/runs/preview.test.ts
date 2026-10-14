import { adoptResult, connect, createElement, type PleinDoc, setParams, writeRun } from '@plein/doc'
import type { AssetRef, ProviderRequest } from '@plein/plugin-sdk'
import type { JobList, PreparedInput } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

afterEach(() => {
  vi.restoreAllMocks()
})

const asset = (c: string) => c.repeat(64)

function card(doc: PleinDoc, nodeType: string, name: string, image: string | null, x: number) {
  const id = addNode(doc, nodeType, { name, params: { description: `${name}的设定` }, x, y: 0 })
  if (image) {
    const img = createElement(doc, { kind: 'image', assetId: image, x, y: -300, w: 10, h: 10 })
    connect(doc, [img, 'image'], [id, 'references'])
  }
  return id
}

/** mock 图片模型临时声明最多收三张参考图 */
function limitReferences(max: number) {
  const model = mockProvider.models.find((m) => m.id === 'image')!
  const before = model.limits
  model.limits = { ...before, references: { max } }
  return () => {
    model.limits = before
  }
}

async function boot() {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const hero = card(doc, 'plein/character', '林夏', asset('a'), 0)
  card(doc, 'plein/scene', '天台', asset('b'), 300)
  card(doc, 'plein/prop', '铁盒', asset('c'), 600)
  const key = card(doc, 'plein/prop', '钥匙', asset('d'), 900)
  const shot = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏 @天台 @铁盒 @钥匙 推门而入' },
    y: 400,
  })
  return { server, id, doc, hero, key, shot }
}

const preview = async (server: Server, canvas: string, node: string) => {
  const res = await request(server, `/api/canvases/${canvas}/nodes/${node}/input`)
  expect(res.status).toBe(200)
  return (await res.json()) as PreparedInput
}

const run = (server: Server, canvas: string, node: string, expect?: string) =>
  request(server, `/api/canvases/${canvas}/nodes/${node}/run`, {
    method: 'POST',
    body: JSON.stringify(expect ? { expect } : {}),
  })

/** 记下送到 mock 平台的参考图 */
function captureSubmits() {
  const seen: Array<{ prompt: string; references: AssetRef[] }> = []
  const submit = mockProvider.submit
  vi.spyOn(mockProvider, 'submit').mockImplementation(async (req: ProviderRequest, ctx) => {
    const input = req.input as { prompt: string; references?: AssetRef[] }
    seen.push({ prompt: input.prompt, references: input.references ?? [] })
    return submit.call(mockProvider, req, ctx)
  })
  return seen
}

describe('实际输入预览', () => {
  it('预览的参考图及顺序与 mock 平台实际收到的一致，且预览不调用平台', async () => {
    const restore = limitReferences(3)
    try {
      const { server, id, doc, key, shot } = await boot()
      setParams(doc, shot, { requiredRefs: [key] })
      const seen = captureSubmits()
      const p = await preview(server, id, shot)
      expect(seen).toEqual([])
      expect(p.model).toEqual({
        ref: 'plein/mock:image',
        provider: 'plein/mock',
        title: 'Mock 图片',
      })
      expect(p).toMatchObject({ v: 1, status: 'ready', nodeVersion: 1 })
      expect(p.inputHash).toMatch(/^v2:/)
      expect(p.referenceLimit).toBe(3)
      expect(p.prompt).toContain('林夏 天台 铁盒 钥匙 推门而入')
      expect(p.prompt).toContain('钥匙：钥匙的设定')
      expect(p.inputs.references?.map((v) => v.assetId)).toEqual([
        asset('a'),
        asset('b'),
        asset('d'),
      ])
      expect(p.refs.find((r) => r.name === '铁盒')).toMatchObject({ reason: 'over_limit' })
      expect(p.blocked).toEqual([])
      expect(p.params).not.toHaveProperty('prompt')
      expect(p.params).not.toHaveProperty('requiredRefs')

      const res = await run(server, id, shot, p.inputHash)
      expect(res.status).toBe(202)
      const { runId } = (await res.json()) as { runId: string }
      expect(await server.runs.wait(runId)).toBe('succeeded')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.references.map((r) => r.assetId)).toEqual(
        p.inputs.references!.map((v) => v.assetId),
      )
      expect(seen[0]!.prompt).toBe(p.prompt)

      // 执行记录里存着同一份实际输入
      const jobs = (await (await request(server, `/api/canvases/${id}/jobs`)).json()) as JobList
      const job = jobs.jobs.find((j) => j.id === runId)!
      expect(job.input?.inputHash).toBe(p.inputHash)
      expect(job.input?.refs).toEqual(p.refs)
      // 结果的缓存键就是预览的 inputHash
      expect(server.runs.store.get(runId)?.cache_key).toBe(p.inputHash)
    } finally {
      restore()
    }
  }, 30_000)

  it('预览后输入变了：带着旧的确认提交被拒绝，返回新的实际输入', async () => {
    const restore = limitReferences(3)
    try {
      const { server, id, doc, key, shot } = await boot()
      const seen = captureSubmits()
      const before = await preview(server, id, shot)
      // 默认：钥匙排在最后被舍弃
      expect(before.refs.find((r) => r.elementId === key)!.sent).toEqual([])
      setParams(doc, shot, { requiredRefs: [key] })
      const res = await run(server, id, shot, before.inputHash)
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; input: PreparedInput }
      expect(body.error).toBe('input_changed')
      expect(body.input.refs.find((r) => r.elementId === key)!.sent).toEqual([asset('d')])
      expect(seen).toEqual([])
      expect(doc.get(shot)?.run).toBeUndefined()
    } finally {
      restore()
    }
  }, 30_000)

  it('设为必需参考不改变已有结果的有效性（只决定取舍）', async () => {
    const { server, id, doc, hero, shot } = await boot()
    const p1 = await preview(server, id, shot)
    // 没有参考图上限时全部都送，设不设必需送的东西一样
    setParams(doc, shot, { requiredRefs: [hero] })
    const p2 = await preview(server, id, shot)
    expect(p2.inputHash).toBe(p1.inputHash)
    expect(p2.refs.find((r) => r.elementId === hero)!.required).toBe(true)
  }, 30_000)

  it('必需参考缺图：预览给出阻断原因，提交后该节点失败且不调用平台', async () => {
    const { server, id, doc } = await boot()
    const empty = card(doc, 'plein/prop', '信封', null, 1200)
    const shot = addNode(doc, 'plein/image', {
      params: { prompt: '@林夏 拿着@信封', requiredRefs: [empty] },
      x: 300,
      y: 400,
    })
    const seen = captureSubmits()
    const p = await preview(server, id, shot)
    expect(p.blocked[0]).toMatchObject({ code: 'required_no_image', elementId: empty })
    expect(p.blocked[0]?.message).toContain('「信封」是必需参考')
    expect(p.status).toBe('blocked')
    expect(p.refs.find((r) => r.elementId === empty)).toMatchObject({ reason: 'no_image' })
    const runId = server.runs.start(id, shot, 'local')
    expect(await server.runs.wait(runId)).toBe('failed')
    await until(() => doc.get(shot)?.run?.status === 'failed')
    expect(doc.get(shot)?.run?.error).toContain('「信封」是必需参考')
    expect(seen).toEqual([])
    // 阻断原因也进了执行记录
    expect(JSON.parse(server.runs.store.get(runId)!.input!).blocked[0]?.message).toContain('信封')
  }, 30_000)

  it('上游没有结果：预览照样返回，原因放进阻断', async () => {
    const { server, id, doc } = await boot()
    const up = addNode(doc, 'plein/image', { params: { prompt: '上游' }, x: 0, y: 800 })
    const down = addNode(doc, 'plein/image', { params: { prompt: '下游' }, x: 300, y: 800 })
    connect(doc, [up, 'images'], [down, 'references'])
    const p = await preview(server, id, down)
    expect(p.blocked[0]?.message).toContain('还没有结果')
    // 准备失败算不出真正的缓存键：不给 inputHash，带了旧哈希提交也会被拦下
    expect(p.blocked[0]?.code).toBe('prepare_failed')
    expect(p.status).toBe('unprepared')
    expect(p.inputHash).toBeUndefined()
  }, 30_000)

  it('卡片的参考图节点生成失败、没有结果：镜头只带文字设定照常运行，提示参考图失败', async () => {
    const { server, id, doc, shot } = await boot()
    const prop = card(doc, 'plein/prop', '证物', null, 1200)
    const gen = addNode(doc, 'plein/image', { params: { prompt: '证物' }, x: 1200, y: -600 })
    connect(doc, [gen, 'images'], [prop, 'references'])
    writeRun(doc, gen, { id: 'r1', status: 'failed', at: 1 })
    setParams(doc, shot, { prompt: '@林夏 @证物 推门而入' })
    const p = await preview(server, id, shot)
    expect(p.status).toBe('ready')
    expect(p.refs.find((r) => r.name === '证物')).toMatchObject({ sent: [], reason: 'failed' })
    expect(p.prompt).toContain('证物的设定')
    const res = await run(server, id, shot)
    expect(res.status).toBe(202)
    const { runId } = (await res.json()) as { runId: string }
    expect(await server.runs.wait(runId)).toBe('succeeded')
  })

  it('换候选：角色卡采用另一张定妆图后，预览里的实际资产跟着换', async () => {
    const { server, id, doc } = await boot()
    const portrait = addNode(doc, 'plein/image', { params: { prompt: '定妆照' }, x: 0, y: 800 })
    const hero = addNode(doc, 'plein/character', { name: '沈默', x: 300, y: 800 })
    connect(doc, [portrait, 'images'], [hero, 'references'])
    for (const prompt of ['定妆照', '定妆照，侧脸']) {
      setParams(doc, portrait, { prompt })
      const runId = server.runs.start(id, portrait, 'local')
      expect(await server.runs.wait(runId)).toBe('succeeded')
      await until(() => !server.runs.isRunning(id, portrait))
    }
    const shot = addNode(doc, 'plein/image', { params: { prompt: '@沈默 回头' }, x: 600, y: 800 })
    const [newest, older] = doc.get(portrait)!.results!
    const assetOf = (r: typeof newest) => (r!.value as { assetId: string }).assetId
    adoptResult(doc, portrait, newest!.id)
    const p1 = await preview(server, id, shot)
    expect(p1.refs.find((r) => r.elementId === hero)!.sent).toEqual([assetOf(newest)])
    adoptResult(doc, portrait, older!.id)
    const p2 = await preview(server, id, shot)
    expect(p2.refs.find((r) => r.elementId === hero)!.sent).toEqual([assetOf(older)])
    expect(p2.inputHash).not.toBe(p1.inputHash)
    // 输入记着取的是上游哪个结果
    const ref = p2.inputs.references?.find((v) => v.assetId === assetOf(older))
    expect(ref).toMatchObject({ resultId: older!.id, runId: older!.runId })
  }, 30_000)

  it('没选模型不运行，也不替用户挑', async () => {
    const { server, id, doc } = await boot()
    const n = addNode(doc, 'plein/image', { params: { prompt: '天台', model: '' }, x: 0, y: 800 })
    const p = await preview(server, id, n)
    expect(p.model).toBeUndefined()
    const runId = server.runs.start(id, n, 'local')
    expect(await server.runs.wait(runId)).toBe('failed')
    const job = server.runs.list(id, 10).jobs.find((j) => j.id === runId)
    expect(job?.error).toContain('还没选「生成图片」用的模型')
  }, 30_000)

  it('打开旧画布：留空的模型补成默认模型，当年自动选中同一个模型的结果仍然有效', async () => {
    const { server, id, doc } = await boot()
    const n = addNode(doc, 'plein/image', { params: { prompt: '天台' }, x: 0, y: 800 })
    const runId = server.runs.start(id, n, 'local')
    expect(await server.runs.wait(runId)).toBe('succeeded')
    await until(() => !server.runs.isRunning(id, n))
    // 模拟升级前：模型留空，服务端自动选了 mock 图片，任务按留空的参数记缓存键
    const runs = server.runs as unknown as {
      prepare(...a: unknown[]): Promise<unknown>
      latestParams(...a: unknown[]): Record<string, unknown>
      resolveModel(ref: string): { ref: string; version?: string; plugin?: string }
      hashKey(...a: unknown[]): string
    }
    const prepared = await runs.prepare(doc, doc.get(n)!, 'local', new AbortController().signal)
    const params = runs.latestParams(doc.get(n)!, prepared)
    const m = runs.resolveModel('plein/mock:image')
    const old =
      'v2:' +
      runs.hashKey(
        doc.get(n)!,
        prepared,
        [],
        new Set(['requiredRefs', 'usedRefs']),
        { model: { ref: m.ref, version: m.version, plugin: m.plugin } },
        { ...params, model: '' },
      )
    server.runs.store.update(runId, { cache_key: old })
    setParams(doc, n, { model: '' })
    // 房间卸载后重新打开，留空的模型补成默认模型
    server.rooms.unload(id)
    const reopened = server.rooms.get(id)
    expect(reopened.doc.getMap('elements').size).toBeGreaterThan(0)
    expect(server.rooms.withDoc(id, (d) => d.get(n)!.params?.model)).toBe('plein/mock:image')
    const stale = async () => (await server.runs.staleNodes(id, 'local')).stale
    expect(await stale()).not.toContain(n)
  }, 30_000)

  it('升级前的缓存键（无版本前缀）仍按旧算法认作有效，不整组重跑', async () => {
    const { server, id, doc } = await boot()
    const n = addNode(doc, 'plein/image', { params: { prompt: '天台' }, x: 0, y: 800 })
    const runId = server.runs.start(id, n, 'local')
    expect(await server.runs.wait(runId)).toBe('succeeded')
    await until(() => !server.runs.isRunning(id, n))
    const stale = async () => (await server.runs.staleNodes(id, 'local')).stale
    expect(await stale()).not.toContain(n)
    // 换成旧算法算出的键，模拟升级前的任务记录
    const runs = server.runs as unknown as {
      prepare(...a: unknown[]): Promise<unknown>
      legacyCacheKey(...a: unknown[]): string
    }
    const prepared = await runs.prepare(doc, doc.get(n)!, 'local', new AbortController().signal)
    const legacy = runs.legacyCacheKey(doc.get(n)!, prepared, [])
    expect(legacy).not.toMatch(/^v2:/)
    server.runs.store.update(runId, { cache_key: legacy })
    expect(await stale()).not.toContain(n)
    setParams(doc, n, { prompt: '天台，夜' })
    expect(await stale()).toContain(n)
  }, 30_000)

  it('整组运行：必需参考缺图的镜头不提交，无关镜头照常完成', async () => {
    const { server, id, doc } = await boot()
    const frame = createElement(doc, { kind: 'frame', x: -100, y: 1000, w: 1200, h: 400 })
    const empty = card(doc, 'plein/prop', '信封', null, 1200)
    const bad = addNode(doc, 'plein/image', {
      params: { prompt: '@林夏 拿着@信封', requiredRefs: [empty] },
      x: 0,
      y: 1100,
      parentId: frame,
    })
    const good = addNode(doc, 'plein/image', {
      params: { prompt: '@林夏 在天台' },
      x: 300,
      y: 1100,
      parentId: frame,
    })
    const res = await request(server, `/api/canvases/${id}/frames/${frame}/run`, {
      method: 'POST',
      body: '{}',
    })
    const { groupId } = (await res.json()) as { groupId: string }
    const state = await until(() => {
      const s = server.runs.groupState(groupId, 'local')
      return s?.status !== 'running' && s
    })
    expect(state.summary).toMatchObject({ succeeded: 1, failed: 1 })
    expect(doc.get(bad)?.run?.status).toBe('failed')
    expect(doc.get(good)?.run?.status).toBe('succeeded')
  }, 30_000)
})

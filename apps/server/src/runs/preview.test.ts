import { Readable } from 'node:stream'
import {
  addResults,
  adoptResult,
  connect,
  createDoc,
  createElement,
  inputEdges,
  moveElements,
  reorderInputs,
  removeEdges,
  updateElement,
  type PleinDoc,
  setParams,
  writeRun,
} from '@plein/doc'
import {
  videoReferencePrompt,
  type AssetRef,
  type ProviderRequest,
  type SubmitResult,
} from '@plein/plugin-sdk'
import type { JobList, PreparedInput } from '@plein/protocol'
import { arkProvider, minimaxProvider, mockProvider } from '@plein/providers'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import * as Y from 'yjs'
import type { Server } from '../app'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

afterEach(() => {
  vi.restoreAllMocks()
})

it('布局移动不改变首尾帧实际输入与缓存；显式重排才改变', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const first = createElement(doc, {
    kind: 'image',
    assetId: 'a'.repeat(64),
    x: 0,
    y: 400,
    w: 100,
    h: 100,
  })
  const last = createElement(doc, {
    kind: 'image',
    assetId: 'b'.repeat(64),
    x: 0,
    y: -400,
    w: 100,
    h: 100,
  })
  const video = addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', mode: 'frames', prompt: '开门' },
  })
  connect(doc, [first, 'image'], [video, 'images'])
  connect(doc, [last, 'image'], [video, 'images'])
  const before = await preview(server, id, video)
  moveElements(doc, [first], 800, -2000)
  const moved = await preview(server, id, video)
  expect(moved.inputHash).toBe(before.inputHash)
  expect(moved.inputs).toEqual(before.inputs)
  const ordered = inputEdges(doc, video, 'images')
  reorderInputs(doc, [video, 'images'], ordered.map((e) => e.id).reverse())
  const changed = await preview(server, id, video)
  expect(changed.inputHash).not.toBe(before.inputHash)
  expect(changed.inputs.images?.map((v) => v.assetId)).toEqual(['b'.repeat(64), 'a'.repeat(64)])
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

/** 带名字的图片元素；连线用 */
function imgEl(doc: PleinDoc, name: string, assetId: string, x: number) {
  return createElement(doc, { kind: 'image', name, assetId, x, y: 0, w: 100, h: 100 })
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

it('分辨率按实际模型提前校验，修正后的预览和提交一致', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const n = addNode(doc, 'plein/video', {
    params: { model: 'minimax/api:MiniMax-H3', prompt: '水杯特写', resolution: '1080p' },
  })
  const blocked = await preview(server, id, n)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked).toContainEqual({
    code: 'prepare_failed',
    message: 'MiniMax-H3 不支持分辨率 1080p；请选择 768P、2K，或使用默认分辨率',
  })
  setParams(doc, n, { resolution: '2K' })
  expect((await preview(server, id, n)).status).toBe('ready')
  setParams(doc, n, { model: 'minimax/api:MiniMax-H3-Max' })
  expect((await preview(server, id, n)).blocked[0]?.message).toContain('480P、768P')
  setParams(doc, n, { resolution: '' })
  expect((await preview(server, id, n)).status).toBe('ready')
  setParams(doc, n, { model: 'plein/mock:video', resolution: '2K' })
  const submit = vi.spyOn(mockProvider, 'submit')
  const failed = server.runs.start(id, n, 'local')
  expect(await server.runs.wait(failed)).toBe('failed')
  expect(submit).not.toHaveBeenCalled()
  await until(() => !server.runs.isRunning(id, n))
  setParams(doc, n, { resolution: '1080p' })
  const ready = await preview(server, id, n)
  expect(ready.status).toBe('ready')
  const res = await run(server, id, n, ready.inputHash)
  const { runId } = (await res.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit.mock.calls[0]![0].input).toMatchObject({ resolution: '1080p' })
}, 30_000)

it('时长超出模型上限时在准备阶段阻断，不把越界值送给平台', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  // mock 视频模型临时声明最长 15 秒
  const model = mockProvider.models.find((m) => m.id === 'video')!
  const before = model.limits
  model.limits = { ...before, duration: { min: 2, max: 15 } }
  try {
    const n = addNode(doc, 'plein/video', {
      params: { model: 'plein/mock:video', prompt: '推门', duration: 30 },
    })
    const blocked = await preview(server, id, n)
    expect(blocked.status).toBe('blocked')
    expect(blocked.blocked).toContainEqual({
      code: 'prepare_failed',
      message: 'Mock 视频 的时长须为 2–15 秒，现在是 30 秒',
    })
    setParams(doc, n, { duration: 10 })
    expect((await preview(server, id, n)).status).toBe('ready')
  } finally {
    model.limits = before
  }
})

it('专属参数只校验所选模型，不把字符串 false 当成布尔值或自动修改原值', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const model = 'plein/mock:image'
  const n = addNode(doc, 'plein/image', {
    params: { model, prompt: '检查参数类型', options: { [model]: { watermark: 'false' } } },
  })
  const blocked = await preview(server, id, n)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked[0]?.message).toContain('水印')
  expect(doc.get(n)!.params!.options).toEqual({ [model]: { watermark: 'false' } })
  for (const options of [null, [], { [model]: null }, { [model]: [] }]) {
    setParams(doc, n, { options })
    const invalid = await preview(server, id, n)
    expect(invalid.status).toBe('blocked')
    expect(invalid.blocked[0]?.message).toContain('参数格式')
  }
  setParams(doc, n, { options: { [model]: { watermark: 'false' } } })
  const submit = vi.spyOn(mockProvider, 'submit')
  const failed = server.runs.start(id, n, 'local')
  expect(await server.runs.wait(failed)).toBe('failed')
  expect(submit).not.toHaveBeenCalled()
  await until(() => !server.runs.isRunning(id, n))
  setParams(doc, n, {
    options: {
      [model]: { watermark: false, customExtension: 'preserved' },
      'minimax/api:speech-2.8-hd': { emotion: '无效的其他模型参数' },
    },
  })
  const ready = await preview(server, id, n)
  expect(ready.status).toBe('ready')
  const res = await run(server, id, n, ready.inputHash)
  const { runId } = (await res.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit.mock.calls[0]![0].input).toMatchObject({
    extra: { watermark: false, customExtension: 'preserved' },
  })
  await until(() => !server.runs.isRunning(id, n))
  setParams(doc, n, { options: { [model]: {} } })
  const reset = await preview(server, id, n)
  expect(reset.status).toBe('ready')
  const resetRun = server.runs.start(id, n, 'local')
  expect(await server.runs.wait(resetRun)).toBe('succeeded')
  expect(submit.mock.calls[1]![0].input.extra).not.toHaveProperty('watermark')
}, 30_000)

it('不支持自由语气的配音模型在预览时阻断，官方情绪标签仍可准备', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const model = 'minimax/api:speech-2.8-hd'
  const n = addNode(doc, 'plein/speech', {
    params: { model, text: '你好。', instruction: '低声哭腔' },
  })
  const blocked = await preview(server, id, n)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked).toContainEqual({
    code: 'prepare_failed',
    message: expect.stringContaining('不支持这段语气指令'),
  })
  setParams(doc, n, { instruction: '悲伤' })
  expect((await preview(server, id, n)).status).toBe('ready')
  setParams(doc, n, { options: { [model]: { emotion: '自定义' } } })
  const invalid = await preview(server, id, n)
  expect(invalid.status).toBe('blocked')
  expect(invalid.blocked).toContainEqual({
    code: 'prepare_failed',
    message: expect.stringContaining('情绪（emotion）'),
  })
  setParams(doc, n, { instruction: '' })
  expect((await preview(server, id, n)).status).toBe('blocked')
  const execute = vi.spyOn(server.plugins, 'runNode')
  const invalidRun = server.runs.start(id, n, 'local')
  expect(await server.runs.wait(invalidRun)).toBe('failed')
  expect(execute).not.toHaveBeenCalled()
  expect(server.runs.store.get(invalidRun)?.error).toContain('情绪（emotion）')
  await until(() => !server.runs.isRunning(id, n))
  setParams(doc, n, { options: { [model]: { emotion: 'calm' } } })
  expect((await preview(server, id, n)).status).toBe('ready')
  setParams(doc, n, { options: {}, instruction: '', model: 'plein/mock:audio' })
  const ready = await preview(server, id, n)
  expect(ready.status).toBe('ready')
  const submit = vi.spyOn(mockProvider, 'submit')
  const res = await run(server, id, n, ready.inputHash)
  expect(res.status).toBe(202)
  const { runId } = (await res.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  expect(submit.mock.calls[0]![0].input).toMatchObject({ text: '你好。' })
  expect(submit.mock.calls[0]![0].input).not.toHaveProperty('instruction', '低声哭腔')
}, 30_000)

it('已受理的历史参数按冻结记录恢复，不因新增校验阻断取回或重新提交', async () => {
  const first = await bootServer()
  mockSettings(first.server, { latencyMs: 500 })
  const { id, doc } = await createCanvas(first.server)
  const model = mockProvider.models.find((m) => m.id === 'image')!
  const schema = model.options
  const submit = vi.spyOn(mockProvider, 'submit')
  try {
    // 模拟旧版本尚未声明该字段类型时已经受理的任务。
    model.options = undefined
    const node = addNode(doc, 'plein/image', {
      params: {
        model: 'plein/mock:image',
        prompt: '历史任务',
        options: { 'plein/mock:image': { watermark: 'false' } },
      },
    })
    const run = first.server.runs.start(id, node, 'local')
    await until(() => first.server.runs.store.get(run)?.calls.includes('pending'))
    await first.close()
    model.options = schema
    const second = await bootServer({ dataDir: first.dataDir })
    expect(await second.server.runs.wait(run)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await preview(second.server, id, node)).status).toBe('blocked')
  } finally {
    model.options = schema
    submit.mockRestore()
  }
})

it('手选跨平台音色在预览时阻止提交，修正音色后执行使用修正后的 ID', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const n = addNode(doc, 'plein/speech', {
    params: {
      model: 'plein/mock:audio',
      text: '测试手选音色的恢复。',
      voice: { provider: 'minimax/api', voiceId: 'foreign-voice' },
    },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const blocked = await preview(server, id, n)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked).toEqual([
    { code: 'prepare_failed', message: expect.stringContaining('请换成同一平台的音色或模型') },
  ])
  const failed = server.runs.start(id, n, 'local')
  expect(await server.runs.wait(failed)).toBe('failed')
  expect(submit).not.toHaveBeenCalled()
  await until(() => !server.runs.isRunning(id, n))
  setParams(doc, n, { voice: { provider: 'plein/mock', voiceId: 'mock-male' } })
  const ready = await preview(server, id, n)
  expect(ready.status).toBe('ready')
  expect(ready.inputHash).not.toBe(blocked.inputHash)
  const res = await run(server, id, n, ready.inputHash)
  expect(res.status).toBe(202)
  const { runId } = (await res.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  expect(submit).toHaveBeenCalledTimes(1)
  expect(submit.mock.calls[0]![0].input).toMatchObject({ voice: 'mock-male' })
}, 30_000)

it('旧画布未标平台的手选音色提前提示，仍按原 ID 提交', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const n = addNode(doc, 'plein/speech', {
    params: { model: 'plein/mock:audio', text: '旧音色兼容检查。', voice: 'mock-female' },
  })
  const submit = vi.spyOn(mockProvider, 'submit')
  const p = await preview(server, id, n)
  expect(p.status).toBe('ready')
  expect(p.notices).toEqual([
    { code: 'voice_unverified', message: expect.stringContaining('未标明所属平台') },
  ])
  const res = await run(server, id, n, p.inputHash)
  expect(res.status).toBe(202)
  const { runId } = (await res.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  expect(submit.mock.calls[0]![0].input).toMatchObject({ voice: 'mock-female' })
}, 30_000)

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
      expect(p.prompt).toContain('林夏（图1） 天台（图2） 铁盒 钥匙（图3） 推门而入')
      expect(p.prompt).not.toContain('参考对应')
      expect(p.prompt).not.toContain('钥匙的设定')
      expect(p.inputs.references?.map((v) => v.assetId)).toEqual([
        asset('a'),
        asset('b'),
        asset('d'),
      ])
      expect(p.refs.find((r) => r.name === '铁盒')).toMatchObject({ reason: 'over_limit' })
      expect(p.sent?.map((item) => [item.index, item.assetId, item.origins])).toEqual([
        [1, asset('a'), ['mention', 'role']],
        [2, asset('b'), ['mention']],
        [3, asset('d'), ['mention']],
      ])
      expect(p.unsent).toContainEqual(
        expect.objectContaining({ assetId: asset('c'), name: '铁盒', reason: 'over_limit' }),
      )
      expect(p.promptReferences?.map((item) => item.indices)).toEqual([[1], [2], [], [3]])
      expect(p.promptReferences?.map((item) => [item.start, item.end, item.text])).toEqual([
        [0, 3, '@林夏'],
        [4, 7, '@天台'],
        [8, 11, '@铁盒'],
        [12, 15, '@钥匙'],
      ])
      expect(p.promptReferences?.[2]).toMatchObject({ name: '铁盒', reason: 'over_limit' })
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

  it('分析文档副本时准备失败：摘要保留副本里的改动，不读取原画布', async () => {
    const { server, id, doc } = await boot()
    const node = addNode(doc, 'plein/image', { params: { prompt: '原画布提示词' } })
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(server.rooms.get(id).doc))
    const sim = createDoc(copy)
    try {
      setParams(sim, node, { prompt: '修改方案中的提示词' })
      const up = addNode(sim, 'plein/image', { name: '副本中缺少结果的上游' })
      connect(sim, [up, 'images'], [node, 'references'])
      const seen = captureSubmits()
      const actual = await server.runs.inspect(
        sim,
        sim.get(node)!,
        'local',
        new AbortController().signal,
      )
      expect(actual.input).toMatchObject({
        status: 'unprepared',
        prompt: '修改方案中的提示词',
        blocked: [
          { code: 'prepare_failed', message: expect.stringContaining('副本中缺少结果的上游') },
        ],
      })
      expect(actual.input.inputHash).toBeUndefined()
      expect(actual.inputs).toEqual({})
      expect(actual.matches({ cache_key: 'old', cache_omit: null })).toBe(false)
      expect(await preview(server, id, node)).toMatchObject({
        status: 'ready',
        prompt: '原画布提示词',
        blocked: [],
      })
      expect(seen).toEqual([])
    } finally {
      sim.destroy()
      copy.destroy()
    }
  })

  it('卡片的参考图节点生成失败、没有结果：镜头只保留引用名称照常运行，提示参考图失败', async () => {
    const { server, id, doc, shot } = await boot()
    const prop = card(doc, 'plein/prop', '证物', null, 1200)
    const gen = addNode(doc, 'plein/image', { params: { prompt: '证物' }, x: 1200, y: -600 })
    connect(doc, [gen, 'images'], [prop, 'references'])
    writeRun(doc, gen, { id: 'r1', status: 'failed', at: 1 })
    setParams(doc, shot, { prompt: '@林夏 @证物 推门而入' })
    const p = await preview(server, id, shot)
    expect(p.status).toBe('ready')
    expect(p.refs.find((r) => r.name === '证物')).toMatchObject({ sent: [], reason: 'failed' })
    expect(p.prompt).not.toContain('证物的设定')
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

  it('同一上游的不同输出端口各自保留结果来源，直接连入和 @ 引用不串值', async () => {
    const { server, id, doc } = await boot()
    const up = addNode(doc, 'test/multiple-images', {
      ports: {
        inputs: [],
        outputs: [
          { id: 'front', label: '正面', type: 'image' },
          { id: 'side', label: '侧面', type: 'image' },
        ],
      },
    })
    const results = [
      { id: 'front', port: 'front', value: { type: 'image' as const, assetId: asset('e') } },
      { id: 'side', port: 'side', value: { type: 'image' as const, assetId: asset('f') } },
    ].map((r) => ({ ...r, runId: 'multi-output', at: 1 }))
    addResults(doc, up, results)
    const hero = card(doc, 'plein/character', '测试角色', null, 0)
    expect(connect(doc, [up, 'side'], [hero, 'references'])).not.toBeNull()
    const shot = addNode(doc, 'plein/image', { params: { prompt: '@测试角色 转身' } })
    expect(connect(doc, [up, 'front'], [shot, 'references'])).not.toBeNull()
    const input = await preview(server, id, shot)
    expect(input.inputs.references).toEqual([
      { type: 'image', assetId: asset('e'), source: up, resultId: 'front', runId: 'multi-output' },
      { type: 'image', assetId: asset('f'), source: up, resultId: 'side', runId: 'multi-output' },
    ])
  })

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
    // 升级前还不存在角色选图字段，历史缓存键不包含这个中性默认值。
    const legacyParams = { ...params }
    delete legacyParams.referenceImagePicks
    const old =
      'v2:' +
      runs.hashKey(
        doc.get(n)!,
        prepared,
        [],
        new Set(['requiredRefs', 'usedRefs']),
        { model: { ref: m.ref, version: m.version, plugin: m.plugin } },
        { ...legacyParams, model: '' },
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

it('声音复刻模型在预览时拒绝预置音色并点名模型', async () => {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/speech', {
    params: {
      model: 'doubao/speech:seed-icl-2.0',
      text: '你来了',
      voice: { provider: 'doubao/speech', voiceId: 'BV001_streaming' },
    },
  })
  const input = await preview(server, id, node)
  expect(input.blocked).toContainEqual({
    code: 'prepare_failed',
    message:
      '豆包声音复刻 2.0（已有音色） 只能用已创建的复刻或设计音色，当前是预置音色 BV001_streaming',
  })
})

it('音乐和独立识别预览明确当前模型权限未知，检查本身不发生成请求', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const submit = vi.spyOn(mockProvider, 'submit')
  const audio = createElement(doc, {
    kind: 'audio',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  for (const type of ['plein/music', 'plein/transcribe']) {
    const node = addNode(doc, type, { params: { model: 'plein/mock:audio', prompt: '安静的配乐' } })
    if (type === 'plein/transcribe') connect(doc, [audio, 'audio'], [node, 'audio'])
    const input = await preview(server, id, node)
    expect(input.notices).toContainEqual({
      code: 'model_access_unverified',
      message: expect.stringContaining('Mock 音频 的当前账户权限尚未验证'),
    })
    expect(input.blocked).not.toContainEqual(
      expect.objectContaining({ code: 'model_access_unverified' }),
    )
  }
  expect(submit).not.toHaveBeenCalled()
})

it('原生序列本地导出即使保留识别模型设置，也不冒称即将调用ASR', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const video = createElement(doc, {
    kind: 'video',
    assetId: asset('b'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const sequence = addNode(doc, 'plein/sequence', {
    params: { model: 'plein/mock:audio', asrTiming: true, clips: [{ source: video }] },
  })
  connect(doc, [video, 'video'], [sequence, 'clips'])
  const submit = vi.spyOn(mockProvider, 'submit')
  const input = await preview(server, id, sequence)
  expect(input.notices.some((notice) => notice.code === 'model_access_unverified')).toBe(false)
  expect(submit).not.toHaveBeenCalled()
})

it('首帧与尾帧模式下，@ 已送入的帧图不再误报未送入', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const first = createElement(doc, {
    kind: 'image',
    name: '首帧.png',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const last = createElement(doc, {
    kind: 'image',
    name: '尾帧.png',
    assetId: asset('b'),
    x: 200,
    y: 0,
    w: 100,
    h: 100,
  })
  card(doc, 'plein/character', '林夏', asset('c'), 400)
  const cases = [
    {
      mode: 'image',
      sources: [first],
      prompt: '@首帧.png 里的人转身',
      final: '首帧.png 里的人转身',
      indices: [[1]],
    },
    {
      mode: 'lastFrame',
      sources: [last],
      prompt: '@尾帧.png 作为结束',
      final: '尾帧.png 作为结束',
      indices: [[1]],
    },
    {
      mode: 'frames',
      sources: [first, last],
      prompt: '从 @首帧.png 过渡到 @尾帧.png，@林夏 走过',
      final: '从 首帧.png 过渡到 尾帧.png，林夏 走过',
      indices: [[1], [2], []],
    },
  ]
  for (const item of cases) {
    const video = addNode(doc, 'plein/video', {
      params: { model: 'plein/mock:video', mode: item.mode, prompt: item.prompt },
    })
    for (const source of item.sources) connect(doc, [source, 'image'], [video, 'images'])
    const input = await preview(server, id, video)
    expect(input.status).toBe('ready')
    expect(input.prompt).toBe(item.final)
    expect(input.promptReferences?.map((ref) => ref.indices)).toEqual(item.indices)
    expect(input.unsent?.some((ref) => ['首帧.png', '尾帧.png'].includes(ref.name))).toBe(false)
    const unsupported = input.notices.filter((notice) => notice.code === 'unsupported_refs')
    if (item.mode === 'frames') {
      expect(input.unsent).toContainEqual(
        expect.objectContaining({ name: '林夏', reason: 'unsupported' }),
      )
      expect(unsupported).toHaveLength(1)
      expect(unsupported[0]?.message).toContain('林夏')
      expect(unsupported[0]?.message).not.toContain('首帧.png、尾帧.png')
    } else expect(unsupported).toEqual([])
  }
})

it('仅尾帧在不支持它的平台预览阶段即阻断', async () => {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const image = createElement(doc, {
    kind: 'image',
    assetId: 'a'.repeat(64),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  for (const model of ['volc/ark:doubao-seedance-2-5-260628', 'aliyun/bailian:wan3.0-video']) {
    const node = addNode(doc, 'plein/video', {
      params: { model, mode: 'lastFrame', prompt: '结束画面' },
    })
    connect(doc, [image, 'image'], [node, 'images'])
    const result = await server.runs.preview(id, node, 'local')
    expect(result.status).toBe('blocked')
    expect(result.blocked.some((p) => p.message.includes('不支持「仅尾帧」模式'))).toBe(true)
  }
})

it('续镜旧连线缺失时仍以保存的尾帧为图片1，合并角色引用并去重', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const parent = createElement(doc, {
    kind: 'video',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const frame = createElement(doc, {
    kind: 'image',
    assetId: asset('b'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const other = createElement(doc, {
    kind: 'image',
    assetId: asset('c'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  card(doc, 'plein/character', '接续角色', asset('d'), 0)
  const video = addNode(doc, 'plein/video', {
    params: {
      model: 'plein/mock:video',
      mode: 'reference',
      prompt: '@接续角色 继续表演',
      continuesFrom: {
        elementId: parent,
        assetId: asset('a'),
        last: true,
        frameAssetId: asset('b'),
      },
    },
  })
  connect(doc, [other, 'image'], [video, 'images'])
  const missingEdge = await preview(server, id, video)
  expect(missingEdge.inputs.images?.map((v) => v.assetId)).toEqual([
    asset('b'),
    asset('c'),
    asset('d'),
  ])
  expect(missingEdge.inputs.images?.[0]?.source).toBe(frame)
  connect(doc, [frame, 'image'], [video, 'images'])
  const linked = await preview(server, id, video)
  expect(linked.inputs.images?.map((v) => v.assetId)).toEqual([asset('b'), asset('c'), asset('d')])
  expect(linked.inputHash).toBe(missingEdge.inputHash)
})

it('持久引用在服务端重排后按身份映射，替换、删除及旧编号阻断', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const sources = ['a', 'b'].map((value) =>
    createElement(doc, {
      kind: 'image',
      assetId: value.repeat(64),
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    }),
  )
  const video = addNode(doc, 'plein/video', {
    params: {
      model: 'plein/mock:video',
      mode: 'reference',
      prompt: '@image1 移动',
      referenceBindings: {
        'image1:a': { type: 'image', assetId: 'a'.repeat(64), source: sources[0] },
      },
    },
  })
  for (const source of sources) connect(doc, [source, 'image'], [video, 'images'])
  const edges = inputEdges(doc, video, 'images')
  reorderInputs(doc, [video, 'images'], edges.map((edge) => edge.id).reverse())
  const reordered = await preview(server, id, video)
  expect(reordered.params.prompt).toBeUndefined()
  expect(reordered.prompt).toContain('@image2')
  expect(reordered.blocked.filter((issue) => issue.message.includes('引用 @image1'))).toEqual([])
  updateElement(doc, sources[0]!, { assetId: 'c'.repeat(64) })
  expect(
    (await preview(server, id, video)).blocked.some((issue) =>
      issue.message.includes('已删除、替换'),
    ),
  ).toBe(true)
  // 断开连线后这条绑定就是残留数据：忽略，不再阻断，也不参与编号。
  removeEdges(doc, [edges[0]!.id])
  const disconnected = await preview(server, id, video)
  expect(disconnected.blocked).toEqual([])
  expect(disconnected.status).not.toBe('blocked')
  expect(disconnected.unsent?.some((item) => item.reason === 'stale_binding')).toBe(true)
  setParams(doc, video, { referenceBindings: undefined })
  expect((await preview(server, id, video)).blocked).toEqual([])
})

it('无持久绑定的旧 @imageN 按送入顺序映射，越界时阻断', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const source = createElement(doc, {
    kind: 'image',
    name: '首图.png',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const cases = [
    { type: 'plein/image', model: 'plein/mock:image', port: 'references', label: '图1' },
    { type: 'plein/video', model: 'minimax/api:MiniMax-H3', port: 'images', label: '图片1' },
    {
      type: 'plein/video',
      model: 'volc/ark:doubao-seedance-2-0-260128',
      port: 'images',
      label: '@image1',
    },
  ]
  for (const item of cases) {
    const node = addNode(doc, item.type, {
      params: { model: item.model, mode: 'reference', prompt: '@image1 的人走路' },
    })
    connect(doc, [source, 'image'], [node, item.port])
    const ready = await preview(server, id, node)
    expect(ready.status).toBe('ready')
    expect(ready.prompt).toBe(`${item.label} 的人走路`)
    expect(ready.promptReferences).toEqual([
      expect.objectContaining({ text: '@image1', indices: [1] }),
    ])
    expect(ready.unsent?.some((ref) => ref.name === 'image1')).toBe(false)
    expect(ready.notices.some((notice) => notice.code === 'stale_binding')).toBe(false)
  }
  const image = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@image9 的人走路' },
  })
  connect(doc, [source, 'image'], [image, 'references'])
  const blocked = await preview(server, id, image)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked).toContainEqual({
    code: 'prepare_failed',
    message: '引用 @image9 尚未确认素材身份，请从参考素材重新选择',
  })
  expect(blocked.promptReferences).toEqual([
    expect.objectContaining({ text: '@image9', indices: [], reason: 'mention_broken' }),
  ])
  expect(blocked.unsent).toContainEqual(
    expect.objectContaining({ name: 'image9', reason: 'mention_broken' }),
  )
})

it('无持久绑定的旧视频音频编号按实际输入映射，越界时阻断', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  for (const [kind, name, assetId] of [
    ['image', '人物.png', asset('a')],
    ['video', '舞.mp4', asset('c')],
    ['audio', '歌.mp3', asset('d')],
  ] as const)
    createElement(doc, { kind, name, assetId, x: 0, y: 0, w: 100, h: 100 })
  const target = addNode(doc, 'plein/video', {
    params: {
      model: 'minimax/api:MiniMax-H3',
      mode: 'reference',
      prompt: '@image1 @video1 @audio1',
    },
  })
  const sources = [...doc.elements()].filter((element) =>
    ['image', 'video', 'audio'].includes(element.kind),
  )
  for (const source of sources)
    connect(
      doc,
      [source.id, source.kind as 'image' | 'video' | 'audio'],
      [target, source.kind === 'image' ? 'images' : source.kind === 'video' ? 'videos' : 'audios'],
    )
  const ready = await preview(server, id, target)
  expect(ready.status).toBe('ready')
  expect(ready.prompt).toBe('图片1 视频1 音频1')
  expect(ready.unsent).toEqual([])
  expect(ready.notices).toEqual([])
  expect(ready.promptReferences).toEqual([
    expect.objectContaining({ text: '@image1', indices: [1] }),
    expect.objectContaining({ text: '@video1', indices: [1], kind: 'video' }),
    expect.objectContaining({ text: '@audio1', indices: [1], kind: 'audio' }),
  ])
  setParams(doc, target, { prompt: '@video2 @audio2' })
  const blocked = await preview(server, id, target)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked).toEqual(
    expect.arrayContaining([
      {
        code: 'prepare_failed',
        message: '引用 @video2 尚未确认素材身份，请从参考素材重新选择',
      },
      {
        code: 'prepare_failed',
        message: '引用 @audio2 尚未确认素材身份，请从参考素材重新选择',
      },
    ]),
  )
  expect(blocked.promptReferences).toEqual([
    expect.objectContaining({
      text: '@video2',
      indices: [],
      kind: 'video',
      reason: 'mention_broken',
    }),
    expect.objectContaining({
      text: '@audio2',
      indices: [],
      kind: 'audio',
      reason: 'mention_broken',
    }),
  ])
})

it('名称引用使用来源当前结果，文件名不会被重复展开，原始提示词保持名称', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const name = '产品截图 2026.11.01.png'
  const source = createElement(doc, {
    kind: 'image',
    name,
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const video = addNode(doc, 'plein/video', {
    params: {
      model: 'plein/mock:video',
      mode: 'reference',
      prompt: `@${name} 保持构图`,
      [`referenceNameBinding:${encodeURIComponent(name)}:${source}`]: {
        type: 'image',
        assetId: asset('a'),
        source,
      },
    },
  })
  connect(doc, [source, 'image'], [video, 'images'])
  const before = await preview(server, id, video)
  expect(before.status).toBe('ready')
  expect(before.prompt).toContain('@image1 保持构图')
  expect(before.inputs.images).toHaveLength(1)
  updateElement(doc, source, { assetId: asset('b') })
  const after = await preview(server, id, video)
  expect(after.status).toBe('ready')
  expect(after.inputs.images?.map((v) => v.assetId)).toEqual([asset('b')])
  expect(after.prompt).toContain('@image1 保持构图')
  expect(doc.get(video)!.params?.prompt).toBe(`@${name} 保持构图`)
  expect(after.inputHash).not.toBe(before.inputHash)
})

it('MiniMax 正文直接编号，绑定与 @ 共用 sent，历史 null 残留只报告不编号', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const bound = createElement(doc, {
    kind: 'image',
    name: '桌边.png',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  createElement(doc, {
    kind: 'image',
    name: '角色.png',
    assetId: asset('b'),
    x: 200,
    y: 0,
    w: 100,
    h: 100,
  })
  const stale = createElement(doc, {
    kind: 'image',
    name: '旧图.png',
    assetId: asset('c'),
    x: 400,
    y: 0,
    w: 100,
    h: 100,
  })
  const video = addNode(doc, 'plein/video', {
    params: {
      model: 'minimax/api:MiniMax-H3',
      mode: 'reference',
      prompt: '@桌边.png 与 @角色.png',
      [`referenceNameBinding:${encodeURIComponent('桌边.png')}:${bound}`]: {
        type: 'image',
        assetId: asset('a'),
        source: bound,
      },
      [`referenceNameBinding:${encodeURIComponent('旧图.png')}:${stale}`]: null,
      'referenceNameBinding:%E5%B7%B2%E5%88%A0%E9%99%A4.png:missing': null,
    },
  })
  connect(doc, [bound, 'image'], [video, 'images'])
  const input = await preview(server, id, video)
  expect(input.status).toBe('ready')
  expect(input.prompt).toBe('图片1 与 图片2')
  expect(input.prompt).not.toContain('参考对应')
  expect(input.sent?.map((item) => [item.index, item.assetId, item.origins])).toEqual([
    [1, asset('a'), ['edge', 'binding']],
    [2, asset('b'), ['mention']],
  ])
  expect(
    input.unsent?.filter((item) => item.reason === 'stale_binding').map((item) => item.name),
  ).toEqual(['旧图.png', '已删除.png'])
  expect(input.promptReferences?.map((item) => item.indices)).toEqual([[1], [2]])
  expect(doc.get(video)?.params?.prompt).toBe('@桌边.png 与 @角色.png')
})

/**
 * 不变式：面板实际输入（PreparedInput.prompt）必须等于平台真正收到的提示词。
 * mock 全量一致；minimax / ark 视频参考模式下 summarize 与 provider 各有一遍
 * videoReferencePrompt 改写，这条测试锁住两边不偏离。
 */
it('面板实际输入的提示词与平台收到的一致（mock 与 minimax / ark 视频参考）', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  server.plugins.configs.update('minimax/api', {
    enabled: true,
    secrets: { MINIMAX_API_KEY: 'local-test' },
  })
  server.plugins.configs.update('volc/ark', {
    enabled: true,
    secrets: { ARK_API_KEY: 'local-test' },
  })
  const { id, doc } = await createCanvas(server)

  const received: Array<{ provider: string; prompt: string }> = []
  // minimax / ark 的真正改写在它们 submit 内部（替换 submit 会跳过这一步），
  // 所以记录时调用同一个提示词组装函数，得到平台实际发送的那份文案。
  const platformOf: Record<string, 'minimax' | 'ark' | undefined> = {
    'minimax/api': 'minimax',
    'volc/ark': 'ark',
    'plein/mock': undefined,
  }
  const recordPrompt = (provider: string, req: ProviderRequest) => {
    const raw = (req.input as { prompt?: string }).prompt ?? ''
    const platform = platformOf[provider]
    received.push({ provider, prompt: platform ? videoReferencePrompt(raw, platform) : raw })
  }
  const fakeVideo = (): SubmitResult => ({
    state: 'succeeded',
    outputs: [
      {
        type: 'file',
        kind: 'video',
        mime: 'video/webm',
        data: new Uint8Array(Buffer.from(MOCK_WEBM_BASE64, 'base64')),
      },
    ],
  })
  const mockSubmit = mockProvider.submit
  vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
    recordPrompt('plein/mock', req)
    return mockSubmit(req, ctx)
  })
  vi.spyOn(minimaxProvider, 'submit').mockImplementation(async (req) => {
    recordPrompt('minimax/api', req)
    return fakeVideo()
  })
  vi.spyOn(arkProvider, 'submit').mockImplementation(async (req) => {
    recordPrompt('volc/ark', req)
    return fakeVideo()
  })

  // 同名卡只建一张，避免多个同名触发消歧阻断
  card(doc, 'plein/character', '林夏', asset('a'), 0)
  const runVideo = async (model: string, prompt: string, withVideo: boolean) => {
    const n = addNode(doc, 'plein/video', {
      params: { model, mode: 'reference', prompt },
      y: 400,
    })
    if (withVideo)
      connect(
        doc,
        [
          createElement(doc, { kind: 'video', assetId: asset('v'), x: 0, y: -300, w: 100, h: 100 }),
          'video',
        ],
        [n, 'videos'],
      )
    const input = await preview(server, id, n)
    expect(input.status).toBe('ready')
    expect(await server.runs.wait(server.runs.start(id, n, 'local'))).toBe('succeeded')
    await until(() => !server.runs.isRunning(id, n))
    return input
  }

  // mock 图片：面板 prompt 与平台收到的一致
  const imgShot = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏 回头' },
    y: 900,
  })
  const imgInput = await preview(server, id, imgShot)
  expect(imgInput.status).toBe('ready')
  expect(await server.runs.wait(server.runs.start(id, imgShot, 'local'))).toBe('succeeded')
  await until(() => !server.runs.isRunning(id, imgShot))

  // mock 视频参考：应用 @ 编号后一致
  const mockVideo = await runVideo('plein/mock:video', '@林夏 走来', false)
  // minimax / ark 视频参考：含手写旧编号 @video1，summarize 与 provider 双重改写后仍一致
  const minimaxVideo = await runVideo('minimax/api:MiniMax-H3', '@林夏 走来 @video1', true)
  const arkVideo = await runVideo('volc/ark:doubao-seedance-2-0-260128', '@林夏 走来 @video1', true)

  const byProvider = (name: string) => received.filter((r) => r.provider === name)
  expect(byProvider('plein/mock')).toHaveLength(2)
  expect(byProvider('plein/mock').map((r) => r.prompt)).toEqual([imgInput.prompt, mockVideo.prompt])

  // minimax：@video1 在面板上已改写成 视频1，平台收到的同一份
  expect(minimaxVideo.prompt).toContain('图片1')
  expect(minimaxVideo.prompt).toContain('视频1')
  expect(minimaxVideo.prompt).not.toContain('@video')
  expect(byProvider('minimax/api')[0]?.prompt).toBe(minimaxVideo.prompt)

  // ark：面板与平台都是 @image1 / @video1 写法
  expect(arkVideo.prompt).toContain('@image1')
  expect(arkVideo.prompt).toContain('@video1')
  expect(byProvider('volc/ark')[0]?.prompt).toBe(arkVideo.prompt)
}, 60_000)

it('旁路改名后越界的 @林夏#2 按普通 blocked 预览，不自动改写提示词', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const first = card(doc, 'plein/character', '林夏', asset('a'), 0)
  card(doc, 'plein/character', '林夏', asset('b'), 300)
  const shot = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏#2 回头' },
    y: 400,
  })
  const ready = await preview(server, id, shot)
  expect(ready.status).toBe('ready')
  expect(ready.prompt).toContain('回头')

  // 旁路改名（不经 renameElement，画布 API / 智能体都可能这么改）：同名集合从 2 变 1，#2 越界
  updateElement(doc, first, { name: '林小夏' })
  const blocked = await preview(server, id, shot)
  expect(blocked.status).toBe('blocked')
  expect(blocked.prompt).toBe('@林夏#2 回头')
  expect(blocked.blocked).toContainEqual({
    code: 'prepare_failed',
    message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏',
  })
  expect(blocked.unsent).toContainEqual(
    expect.objectContaining({ name: '林夏#2', reason: 'mention_ambiguous' }),
  )

  // 改回去后引用恢复，节点重新可运行
  updateElement(doc, first, { name: '林夏' })
  const recovered = await preview(server, id, shot)
  expect(recovered.status).toBe('ready')
  expect(recovered.prompt).toContain('回头')
})

it('未送入的消歧失败条目用用户原文的名字，不补序号；有效引用仍带序号', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  imgEl(doc, 'dup.png', asset('a'), 0)
  imgEl(doc, 'dup.png', asset('b'), 300)
  const shot = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@dup.png#2 和 @dup.png' },
    y: 400,
  })
  const input = await preview(server, id, shot)
  expect(input.status).toBe('blocked')
  // 有效的 @dup.png#2 照常消歧送入，条目名带序号
  expect(input.sent?.map((item) => item.name)).toEqual(['dup.png#2'])
  // 消歧失败的 @dup.png 用用户原文的名字：文案让用户写成 @dup.png#1 或 @dup.png#2，
  // 条目名再显示推断的 dup.png#1 就与文案互相矛盾
  expect(input.unsent).toEqual([
    expect.objectContaining({
      name: 'dup.png',
      reason: 'mention_ambiguous',
      message: '画布上有 2 个「dup.png」，请写成 @dup.png#1 或 @dup.png#2',
    }),
  ])
  expect(input.unsent?.[0]?.message).toContain(`「${input.unsent?.[0]?.name}」`)

  // 越界的 @林夏#2：只有一个「林夏」，按原文取名（带用户写的 #2，不丢也不改）
  card(doc, 'plein/character', '林夏', null, 700)
  const hero = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏#2 回头' },
    y: 800,
  })
  const over = await preview(server, id, hero)
  expect(over.status).toBe('blocked')
  expect(over.blocked).toContainEqual({
    code: 'prepare_failed',
    message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏',
  })
  expect(over.unsent).toEqual([
    expect.objectContaining({ name: '林夏#2', reason: 'mention_ambiguous' }),
  ])
}, 30_000)

it('blocked 与 notices 里内容相同的条目只留一条：同一处引用写多次不再重复报', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  card(doc, 'plein/character', '林夏', null, 0)

  // 同一越界引用 @林夏#3 写了 3 次：只报一条；越界 #2 是另一处引用，不合并
  const shot = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏#3 和 @林夏#3 与 @林夏#2' },
    y: 400,
  })
  const input = await preview(server, id, shot)
  expect(input.status).toBe('blocked')
  expect(input.blocked).toEqual([
    { code: 'prepare_failed', message: '「@林夏#3」不存在，画布上「林夏」只有 @林夏' },
    { code: 'prepare_failed', message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏' },
  ])
  // 未送入列表同理：每个不同的引用名一条，重复写不叠加
  expect(input.unsent?.map((item) => item.name)).toEqual(['林夏#3', '林夏#2'])

  // notices 同一问题：同一断链 @ 写两次只报一条
  const broken = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林小 回头 和 @林小 微笑' },
    y: 700,
  })
  const noticed = await preview(server, id, broken)
  expect(noticed.status).toBe('ready')
  expect(noticed.notices).toEqual([
    {
      code: 'mention_broken',
      message: '提示词里的 @林小 找不到同名资产，可能已被改名为「林夏」，请改过来',
    },
  ])
}, 30_000)

it('消歧失败与有效引用混排、非参考模式视频：原文保留，有效引用照常处理', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  card(doc, 'plein/character', '林夏', null, 0)
  card(doc, 'plein/character', '小王', asset('b'), 300)

  // 图片节点混排：有效的 @小王 照常编号，越界的 @林夏#2 原文保留在最终提示词里
  const shot = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏#2 和 @小王 回头' },
    y: 400,
  })
  const mixed = await preview(server, id, shot)
  expect(mixed.status).toBe('blocked')
  expect(mixed.prompt).toBe('@林夏#2 和 小王（图1） 回头')
  expect(mixed.blocked).toContainEqual({
    code: 'prepare_failed',
    message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏',
  })
  expect(mixed.sent?.map((item) => item.assetId)).toEqual([asset('b')])

  // 文生视频：@林夏#2 原文保留，不被吞成裸名字
  const textVideo = addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', prompt: '@林夏#2 回头' },
    y: 700,
  })
  const text = await preview(server, id, textVideo)
  expect(text.status).toBe('blocked')
  expect(text.prompt).toBe('@林夏#2 回头')
  expect(text.blocked).toContainEqual({
    code: 'prepare_failed',
    message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏',
  })

  // 首帧模式：帧图照常送入，越界引用原文保留，同句有效引用按非参考模式处理
  const frameEl = createElement(doc, {
    kind: 'image',
    assetId: asset('c'),
    x: 600,
    y: -300,
    w: 100,
    h: 100,
  })
  const frameVideo = addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', mode: 'image', prompt: '@林夏#2 和 @小王 开门' },
    y: 1000,
  })
  connect(doc, [frameEl, 'image'], [frameVideo, 'images'])
  const frame = await preview(server, id, frameVideo)
  expect(frame.status).toBe('blocked')
  expect(frame.prompt).toBe('@林夏#2 和 小王 开门')
  expect(frame.sent?.map((item) => item.assetId)).toEqual([asset('c')])
  expect(frame.blocked).toContainEqual({
    code: 'prepare_failed',
    message: '「@林夏#2」不存在，画布上「林夏」只有 @林夏',
  })
})

it('参考图上游生成失败时，提示能定位到失败的上游节点', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const gen = addNode(doc, 'plein/image', { name: '定妆图生成', params: { prompt: '定妆' } })
  const hero = addNode(doc, 'plein/character', { name: '林夏', params: { description: '主角' } })
  connect(doc, [gen, 'images'], [hero, 'references'])
  // 上游还没有结果且最近一次运行失败：卡片没有可用参考图
  writeRun(doc, gen, { id: 'run-1', status: 'failed', at: Date.now() })
  const required = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏 回头', requiredRefs: [hero] },
    y: 400,
  })
  const blocked = await preview(server, id, required)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked).toContainEqual({
    code: 'required_failed',
    elementId: hero,
    message:
      '「林夏」是必需参考，但它的参考图生成失败了（来自「定妆图生成」），请重新生成或取消必需',
  })
  expect(blocked.unsent).toContainEqual(expect.objectContaining({ name: '林夏', reason: 'failed' }))

  // 可选参考不阻断，但同样提示是哪个上游失败了
  setParams(doc, required, { requiredRefs: [] })
  const optional = await preview(server, id, required)
  expect(optional.status).toBe('ready')
  expect(optional.notices).toContainEqual({
    code: 'prepare_failed',
    elementId: hero,
    message: '「林夏」的参考图来自「定妆图生成」，最近一次运行失败，未送入；请重新生成后再运行',
  })

  // 上游成功后提示消失
  addResults(doc, gen, [
    {
      id: 'r1',
      runId: 'run-2',
      port: 'images',
      value: { type: 'image', assetId: asset('c') },
      at: Date.now(),
    },
  ])
  const recovered = await preview(server, id, required)
  expect(recovered.status).toBe('ready')
  expect(recovered.notices).toEqual([])
  expect(recovered.sent?.map((item) => item.assetId)).toEqual([asset('c')])
})

it('误留空格的断链 @ 进入未送入，正文编号与 sent 一致、引用区间可回读原文', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  createElement(doc, {
    kind: 'image',
    name: '角色.png',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  createElement(doc, {
    kind: 'image',
    name: '参考.png',
    assetId: asset('b'),
    x: 200,
    y: 0,
    w: 100,
    h: 100,
  })
  const original = '参考 @ .png 和 @角色.png，再看 @参考.png'
  const video = addNode(doc, 'plein/video', {
    params: { model: 'minimax/api:MiniMax-H3', mode: 'reference', prompt: original },
  })
  const input = await preview(server, id, video)
  expect(input.status).toBe('ready')
  expect(input.sent?.map((item) => [item.index, item.token])).toEqual([
    [1, '图片1'],
    [2, '图片2'],
  ])
  expect([...new Set(input.prompt!.match(/图片\d+/g))].sort()).toEqual(['图片1', '图片2'])
  expect(input.prompt).not.toContain('参考对应')
  expect(input.unsent).toContainEqual(
    expect.objectContaining({ name: '.png', reason: 'mention_broken' }),
  )
  expect(input.promptReferences?.find((item) => item.text === '@ .png')).toMatchObject({
    name: '.png',
    indices: [],
    reason: 'mention_broken',
  })
  for (const item of input.promptReferences ?? [])
    expect(original.slice(item.start, item.end)).toBe(item.text)
  expect(input.promptReferences?.find((item) => item.text === '@角色.png')?.indices).toEqual([1])
  expect(doc.get(video)?.params?.prompt).toBe(original)
})

it('@ 后空白接普通文字时不误报断链引用', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const original = '@ 开头和结尾 @'
  const image = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: original },
  })
  const input = await preview(server, id, image)
  expect(input.status).toBe('ready')
  expect(input.prompt).toBe(original)
  expect(input.unsent).toEqual([])
  expect(input.promptReferences).toEqual([])
  expect(input.notices).toEqual([])
})

it('原文在 @ 前已写同一个名字时只补编号，引用区间仍指向 @ 文本', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  for (const [name, image, x] of [
    ['叶舒', asset('a'), 0],
    ['安可', asset('b'), 200],
  ] as const)
    card(doc, 'plein/character', name, image, x)
  const original = '叶舒@叶舒 与 安可@安可'
  const video = addNode(doc, 'plein/video', {
    params: { model: 'minimax/api:MiniMax-H3', mode: 'reference', prompt: original },
  })
  const input = await preview(server, id, video)
  expect(input.status).toBe('ready')
  expect(input.prompt).toBe('叶舒（图片1） 与 安可（图片2）')
  expect(input.prompt).not.toContain('叶舒叶舒')
  expect(input.prompt).not.toContain('安可安可')
  expect(input.promptReferences?.map((item) => [item.text, item.indices])).toEqual([
    ['@叶舒', [1]],
    ['@安可', [2]],
  ])
  for (const item of input.promptReferences ?? [])
    expect(original.slice(item.start, item.end)).toBe(item.text)
  expect(doc.get(video)?.params?.prompt).toBe(original)
})

it('上游文本中的参考编号随素材重排映射，失效身份在预览中阻断', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const first = createElement(doc, {
    kind: 'image',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const second = createElement(doc, {
    kind: 'image',
    assetId: asset('b'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const prompt = addNode(doc, 'plein/text', { params: { text: '@image1 的人物向前走' } })
  const video = addNode(doc, 'plein/video', {
    params: {
      model: 'plein/mock:video',
      mode: 'reference',
      prompt: '',
      referenceBindings: { image1: { type: 'image', assetId: asset('a'), source: first } },
    },
  })
  connect(doc, [first, 'image'], [video, 'images'])
  connect(doc, [second, 'image'], [video, 'images'])
  connect(doc, [prompt, 'text'], [video, 'prompt'])
  const edges = inputEdges(doc, video, 'images')
  reorderInputs(doc, [video, 'images'], edges.map((edge) => edge.id).reverse())
  const ready = await preview(server, id, video)
  expect(ready.status).toBe('ready')
  expect(ready.prompt).toContain('@image2 的人物向前走')
  updateElement(doc, first, { assetId: asset('c') })
  const blocked = await preview(server, id, video)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked).toContainEqual(
    expect.objectContaining({
      code: 'prepare_failed',
      message: expect.stringContaining('已删除、替换'),
    }),
  )
})

it.each([
  {
    platform: '图片节点',
    type: 'plein/image',
    model: 'plein/mock:image',
    port: 'references',
    first: '图1',
    second: '图2',
  },
  {
    platform: 'MiniMax',
    type: 'plein/video',
    model: 'minimax/api:MiniMax-H3',
    port: 'images',
    first: '图片1',
    second: '图片2',
  },
  {
    platform: '方舟',
    type: 'plein/video',
    model: 'volc/ark:doubao-seedance-2-0-260128',
    port: 'images',
    first: '@image1',
    second: '@image2',
  },
])('$platform：历史绑定、正文旧编号与上游引用分别只映射一次', async (item) => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const first = createElement(doc, {
    kind: 'image',
    name: '叶舒文件.png',
    assetId: asset('a'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const second = createElement(doc, {
    kind: 'image',
    name: '安可.png',
    assetId: asset('b'),
    x: 200,
    y: 0,
    w: 100,
    h: 100,
  })
  const upstream = addNode(doc, 'plein/text', {
    params: { text: '上游 @叶舒文件.png' },
  })
  const target = addNode(doc, item.type, {
    params: {
      model: item.model,
      mode: 'reference',
      prompt: '正文 @image2',
      referenceBindings: {
        // 历史 image1 指向安可；上游叶舒生成的新编号不能再按这条绑定改指安可。
        image1: { type: 'image', assetId: asset('b'), source: second },
      },
    },
  })
  connect(doc, [first, 'image'], [target, item.port])
  connect(doc, [second, 'image'], [target, item.port])
  connect(doc, [upstream, 'text'], [target, 'prompt'])
  const input = await preview(server, id, target)
  expect(input.status).toBe('ready')
  expect(input.prompt).toBe(`正文 ${item.second}\n\n上游 ${item.first}`)
  expect(input.inputs[item.port]?.map((value) => value.assetId)).toEqual([asset('a'), asset('b')])
  expect(input.notices).toEqual([])
})

it('上游文本与节点正文统一解析 @ 引用、去重并汇总未送入', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  card(doc, 'plein/character', '林夏', asset('a'), 0)
  card(doc, 'plein/prop', '铁盒', null, 300)
  const original = '主提示：@林夏'
  const upstreamOriginal = '上游：@林夏 回头，再说 @林夏，手拿@铁盒'
  const upstream = addNode(doc, 'plein/text', { params: { text: upstreamOriginal } })
  const image = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: original },
  })
  connect(doc, [upstream, 'text'], [image, 'prompt'])
  const input = await preview(server, id, image)
  expect(input.status).toBe('ready')
  expect(input.prompt).toBe(
    '主提示：林夏（图1）\n\n上游：林夏（图1） 回头，再说 林夏（图1），手拿铁盒',
  )
  expect(input.inputs.references?.map((ref) => ref.assetId)).toEqual([asset('a')])
  expect(input.sent?.map((ref) => [ref.index, ref.assetId])).toEqual([[1, asset('a')]])
  expect(input.promptReferences).toEqual([expect.objectContaining({ text: '@林夏', indices: [1] })])
  expect(original.slice(input.promptReferences![0]!.start, input.promptReferences![0]!.end)).toBe(
    '@林夏',
  )
  expect(input.unsent).toContainEqual(expect.objectContaining({ name: '铁盒', reason: 'no_image' }))
  expect(doc.get(image)?.params?.prompt).toBe(original)
  expect(doc.get(upstream)?.params?.text).toBe(upstreamOriginal)
})

it('@ 视频与音频元素保留扩展名，并按实际送入顺序编号', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const dance = createElement(doc, {
    kind: 'video',
    name: '舞.mp4',
    assetId: asset('c'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const follow = createElement(doc, {
    kind: 'video',
    name: '跟拍.mov',
    assetId: asset('d'),
    x: 200,
    y: 0,
    w: 100,
    h: 100,
  })
  const song = createElement(doc, {
    kind: 'audio',
    name: '歌.mp3',
    assetId: asset('e'),
    x: 400,
    y: 0,
    w: 100,
    h: 100,
  })
  const original = '动作 @跟拍.mov 接 @舞.mp4，配乐 @歌.mp3'
  for (const item of [
    { model: 'minimax/api:MiniMax-H3', video: ['视频2', '视频1'], audio: '音频1' },
    {
      model: 'volc/ark:doubao-seedance-2-0-260128',
      video: ['@video2', '@video1'],
      audio: '@audio1',
    },
  ]) {
    const video = addNode(doc, 'plein/video', {
      params: { model: item.model, mode: 'reference', prompt: original },
    })
    connect(doc, [dance, 'video'], [video, 'videos'])
    connect(doc, [follow, 'video'], [video, 'videos'])
    connect(doc, [song, 'audio'], [video, 'audios'])
    const input = await preview(server, id, video)
    expect(input.status).toBe('ready')
    expect(input.prompt).toBe(`动作 ${item.video[0]} 接 ${item.video[1]}，配乐 ${item.audio}`)
    expect(input.inputs.videos?.map((value) => value.assetId)).toEqual([asset('c'), asset('d')])
    expect(input.inputs.audios?.map((value) => value.assetId)).toEqual([asset('e')])
    expect(input.promptReferences).toEqual([
      expect.objectContaining({ text: '@跟拍.mov', indices: [2], kind: 'video' }),
      expect.objectContaining({ text: '@舞.mp4', indices: [1], kind: 'video' }),
      expect.objectContaining({ text: '@歌.mp3', indices: [1], kind: 'audio' }),
    ])
    expect(input.unsent).toEqual([])
    expect(doc.get(video)?.params?.prompt).toBe(original)
  }
  const unlinked = addNode(doc, 'plein/video', {
    params: {
      model: 'minimax/api:MiniMax-H3',
      mode: 'reference',
      prompt: '动作 @舞.mp4，配乐 @歌.mp3',
    },
  })
  const automatic = await preview(server, id, unlinked)
  expect(automatic.status).toBe('ready')
  expect(automatic.prompt).toBe('动作 视频1，配乐 音频1')
  expect(automatic.inputs.videos?.map((value) => value.assetId)).toEqual([asset('c')])
  expect(automatic.inputs.audios?.map((value) => value.assetId)).toEqual([asset('e')])
})

it('@ 特效卡送入参考视频并写成名字加视频编号', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const clip = createElement(doc, {
    kind: 'video',
    name: '爆炸.mov',
    assetId: asset('c'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const effect = addNode(doc, 'plein/effect', {
    name: '爆炸',
    params: { description: '快速推近' },
  })
  connect(doc, [clip, 'video'], [effect, 'references'])
  const video = addNode(doc, 'plein/video', {
    params: {
      model: 'minimax/api:MiniMax-H3',
      mode: 'reference',
      prompt: '参考 @爆炸 的运镜',
    },
  })
  const input = await preview(server, id, video)
  expect(input.status).toBe('ready')
  expect(input.prompt).toBe('参考 爆炸（视频1） 的运镜')
  expect(input.inputs.videos?.map((value) => value.assetId)).toEqual([asset('c')])
  expect(input.promptReferences).toEqual([
    expect.objectContaining({ text: '@爆炸', indices: [1], kind: 'video' }),
  ])
  expect(input.unsent).toEqual([])
})

it('模型不收视频音频参考时，@ 引用进入 unsent 且不编号', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  for (const [kind, name, assetId] of [
    ['video', '舞.mp4', asset('c')],
    ['audio', '歌.mp3', asset('d')],
    ['image', '人物.png', asset('a')],
  ] as const)
    createElement(doc, { kind, name, assetId, x: 0, y: 0, w: 100, h: 100 })
  const model = mockProvider.models.find((item) => item.id === 'video')!
  const before = model.limits
  try {
    model.limits = { ...before, referenceMedia: { video: 0, audio: 0 } }
    const video = addNode(doc, 'plein/video', {
      params: {
        model: 'plein/mock:video',
        mode: 'reference',
        prompt: '动作 @舞.mp4，配乐 @歌.mp3，人物 @人物.png',
      },
    })
    const input = await preview(server, id, video)
    expect(input.status).toBe('ready')
    expect(input.prompt).toBe('动作 舞.mp4，配乐 歌.mp3，人物 @image1')
    expect(input.inputs.videos).toBeUndefined()
    expect(input.inputs.audios).toBeUndefined()
    expect(input.inputs.images?.map((value) => value.assetId)).toEqual([asset('a')])
    expect(input.promptReferences).toEqual([
      expect.objectContaining({
        text: '@舞.mp4',
        indices: [],
        kind: 'video',
        reason: 'unsupported',
      }),
      expect.objectContaining({
        text: '@歌.mp3',
        indices: [],
        kind: 'audio',
        reason: 'unsupported',
      }),
      expect.objectContaining({ text: '@人物.png', indices: [1] }),
    ])
    expect(input.unsent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '舞.mp4',
          reason: 'unsupported',
          message: expect.stringContaining('参考视频'),
        }),
        expect.objectContaining({
          name: '歌.mp3',
          reason: 'unsupported',
          message: expect.stringContaining('参考音频'),
        }),
      ]),
    )
  } finally {
    model.limits = before
  }
})

it('MiniMax 最终提示词含上游文本与分隔符，7000 字符边界在预览和执行前一致阻断', async () => {
  const { server } = await bootServer()
  server.plugins.configs.update('minimax/api', {
    enabled: true,
    secrets: { MINIMAX_API_KEY: 'local-contract-test' },
  })
  const { id, doc } = await createCanvas(server)
  const n = addNode(doc, 'plein/video', {
    params: { model: 'minimax/api:MiniMax-H3', prompt: '景'.repeat(6997) },
  })
  const source = addNode(doc, 'plein/text', { params: { text: '海' } })
  connect(doc, [source, 'text'], [n, 'prompt'])
  const boundary = await preview(server, id, n)
  expect(boundary.prompt?.length).toBe(7000)
  expect(boundary.promptLimit).toBe(7000)
  expect(boundary.status).toBe('ready')
  setParams(doc, n, { prompt: '景'.repeat(6998) })
  const blocked = await preview(server, id, n)
  expect(blocked.prompt?.length).toBe(7001)
  expect(blocked.status).toBe('blocked')
  expect(blocked.blocked[0]?.message).toContain('超出 1 字符')
  expect(blocked.blocked[0]?.message).toContain('上游文本')
  const submit = vi.spyOn(minimaxProvider, 'submit')
  const failed = server.runs.start(id, n, 'local')
  expect(await server.runs.wait(failed)).toBe('failed')
  expect(submit).not.toHaveBeenCalled()
  await until(() => !server.runs.isRunning(id, n))
  setParams(doc, n, { prompt: '短提示词' })
  expect((await preview(server, id, n)).status).toBe('ready')
}, 30_000)

it('引用卡片的长描述不隐式加入最终提示词，也不消耗视频字符额度', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const description = '未要求加入的角色设定'.repeat(1000)
  const hero = card(doc, 'plein/character', '林夏', null, 0)
  setParams(doc, hero, { description })
  const prompt = '@林夏' + '景'.repeat(6998)
  const n = addNode(doc, 'plein/video', {
    params: { model: 'minimax/api:MiniMax-H3', prompt },
  })
  const input = await preview(server, id, n)
  expect(input.prompt).toBe('林夏' + '景'.repeat(6998))
  expect(input.prompt?.length).toBe(7000)
  expect(input.status).toBe('ready')
  expect(doc.get(n)?.params?.prompt).toBe(prompt)
  expect(doc.get(hero)?.params?.description).toBe(description)
})

it('图片生成名称引用按实际多图顺序映射，重复提及不重复送图，断连阻断', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const names = ['生成图片#1', '生成图片#2']
  const sources = names.map((_, index) => {
    const source = addNode(doc, 'plein/image', { name: '生成图片' })
    addResults(doc, source, [
      {
        id: `result-${index}`,
        runId: 'source-run',
        at: 1,
        port: 'images',
        value: { type: 'image', assetId: asset(index ? 'b' : 'a') },
      },
    ])
    return source
  })
  const bindings = Object.fromEntries(
    names.map((name, index) => [
      `referenceNameBinding:${encodeURIComponent(name)}:${sources[index]}`,
      { type: 'image', assetId: asset(index ? 'b' : 'a'), source: sources[index] },
    ]),
  )
  const prompt = `保留 @${names[0]} 的人物，在 @${names[1]} 中奔跑，再参考 @${names[0]}`
  const image = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt, ...bindings },
  })
  for (const source of sources) connect(doc, [source, 'images'], [image, 'references'])
  const edges = inputEdges(doc, image, 'references')
  const first = await preview(server, id, image)
  expect(first.status).toBe('ready')
  expect(first.prompt).toBe('保留 图1 的人物，在 图2 中奔跑，再参考 图1')
  expect(first.inputs.references?.map((v) => v.assetId)).toEqual([asset('a'), asset('b')])
  expect(doc.get(image)?.params?.prompt).toBe(prompt)
  reorderInputs(doc, [image, 'references'], edges.map((edge) => edge.id).reverse())
  const reordered = await preview(server, id, image)
  expect(reordered.prompt).toBe('保留 图2 的人物，在 图1 中奔跑，再参考 图2')
  expect(reordered.inputs.references?.map((v) => v.assetId)).toEqual([asset('b'), asset('a')])
  // 同一来源生成新结果时跟随当前采用结果。
  addResults(doc, sources[0]!, [
    {
      id: 'new',
      runId: 'new-run',
      at: 2,
      port: 'images',
      value: { type: 'image', assetId: asset('c') },
    },
  ])
  expect((await preview(server, id, image)).inputs.references?.map((v) => v.assetId)).toEqual([
    asset('b'),
    asset('c'),
  ])
  removeEdges(doc, [edges[0]!.id])
  const disconnected = await preview(server, id, image)
  // 断开连线不再阻断：正文里的 @ 引用还在，素材改由 @ 引用送入，编号也跟着变。
  expect(disconnected.status).toBe('ready')
  expect(disconnected.blocked).toEqual([])
  // 断开连线后那张图不再送入；这条绑定变成残留数据，被忽略，不阻断。
  expect(disconnected.inputs.references?.map((v) => v.assetId)).toEqual([asset('b')])
  expect(disconnected.prompt).toBe('保留 @生成图片#1 的人物，在 图1 中奔跑，再参考 @生成图片#1')
})

it('文生视频模式不使用连线参考图：面板不声称送入，说明原因且不阻断，平台确实没收到图', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const video = addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', mode: 'text', prompt: '一个镜头' },
  })
  connect(doc, [imgEl(doc, '首.png', asset('a'), 0), 'image'], [video, 'images'])
  connect(doc, [imgEl(doc, '尾.png', asset('b'), 200), 'image'], [video, 'images'])
  const input = await preview(server, id, video)
  // 不阻断：文生视频连图只是没用上，不是错误
  expect(input.status).toBe('ready')
  expect(input.blocked).toEqual([])
  // 预览与实际提交一致：面板不声称送入任何参考图
  expect(input.sent).toEqual([])
  expect(input.unsent).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        assetId: asset('a'),
        name: '首.png',
        reason: 'unsupported',
        message: '「首.png」文生视频模式不使用参考图',
        origins: ['edge'],
      }),
      expect.objectContaining({
        assetId: asset('b'),
        name: '尾.png',
        reason: 'unsupported',
        message: '「尾.png」文生视频模式不使用参考图',
      }),
    ]),
  )
  // 真实提交：mock 平台的入参里没有任何图
  const seen: Array<Record<string, unknown>> = []
  const submit = mockProvider.submit
  vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
    seen.push(req.input as Record<string, unknown>)
    return submit.call(mockProvider, req, ctx)
  })
  const res = await run(server, id, video, input.inputHash)
  expect(res.status).toBe(202)
  const { runId } = (await res.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  expect(seen).toHaveLength(1)
  expect(seen[0]).not.toHaveProperty('firstFrame')
  expect(seen[0]).not.toHaveProperty('lastFrame')
  expect(seen[0]).not.toHaveProperty('references')
  expect(seen[0]!['prompt']).toBe(input.prompt)
}, 30_000)

it('首尾帧模式标注用途 role，token 保留编号写法；多模态参考模式不打 role', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const first = imgEl(doc, '首.png', asset('a'), 0)
  const last = imgEl(doc, '尾.png', asset('b'), 200)
  const cases = [
    { mode: 'image', ids: [first], assets: [asset('a')], roles: ['firstFrame'] },
    { mode: 'lastFrame', ids: [last], assets: [asset('b')], roles: ['lastFrame'] },
    {
      mode: 'frames',
      ids: [first, last],
      assets: [asset('a'), asset('b')],
      roles: ['firstFrame', 'lastFrame'],
    },
    { mode: 'reference', ids: [first, last], assets: [asset('a'), asset('b')], roles: [] },
  ] as const
  for (const item of cases) {
    const video = addNode(doc, 'plein/video', {
      params: { model: 'plein/mock:video', mode: item.mode, prompt: '开门' },
    })
    for (const source of item.ids) connect(doc, [source, 'image'], [video, 'images'])
    const input = await preview(server, id, video)
    expect(input.status).toBe('ready')
    expect(input.sent?.map((ref) => [ref.assetId, ref.role, ref.token])).toEqual(
      item.assets.map((assetId, index) => [assetId, item.roles[index], `@image${index + 1}`]),
    )
  }
}, 30_000)

it('同一引用在未送入列表只出现一次，条目名与文案同为带序号 / 视角的显示名', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  // 场景多视角：两个视角引用都缺图
  addNode(doc, 'plein/scene', {
    name: '天台',
    params: {
      description: '天台',
      sceneViews: [
        { id: 'view-front', name: '正面', images: [asset('a')] },
        { id: 'view-back', name: '背面', images: [asset('b')] },
      ],
    },
    x: 0,
  })
  const scene = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@天台/正面 和 @天台/背面' },
    y: 400,
  })
  const multi = await preview(server, id, scene)
  expect(multi.sent).toEqual([])
  // 同一张卡的不同视角是不同引用：逐条列出，不再合并成一条
  expect(multi.unsent?.map((item) => item.name)).toEqual(['天台（正面）', '天台（背面）'])
  // 每一条的名字都出现在自己的文案里（A-6：条目名与文案一致）
  for (const item of multi.unsent ?? []) expect(item.message).toContain(`「${item.name}」`)
  // 同一处引用（mention 路径与 detail 路径）只报一次：每个引用名只出现一条
  const names = multi.unsent?.map((item) => item.name) ?? []
  expect(new Set(names).size).toBe(names.length)
  // 未被汇总的引用状态仍在正文引用区间里
  expect(multi.promptReferences?.map((item) => [item.text, item.reason])).toEqual([
    ['@天台/正面', 'no_image'],
    ['@天台/背面', 'no_image'],
  ])

  // 档案项同理：同一角色的不同时期分别列出
  const hero = card(doc, 'plein/character', '林夏', null, 600)
  setParams(doc, hero, {
    profile: {
      periods: [
        { id: 'p-child', name: '童年', images: [] },
        { id: 'p-adult', name: '青年', images: [] },
      ],
      expressions: [],
    },
  })
  const picks = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏/童年 和 @林夏/青年' },
    y: 800,
  })
  const both = await preview(server, id, picks)
  expect(both.sent).toEqual([])
  expect(both.unsent?.map((item) => item.name)).toEqual(['林夏（童年）', '林夏（青年）'])
  for (const item of both.unsent ?? []) expect(item.message).toContain(`「${item.name}」`)

  // 重名 #2：mention 路径与 detail 路径不再各报一条
  card(doc, 'plein/character', '林夏', null, 1200)
  card(doc, 'plein/character', '林夏', null, 1500)
  const dup = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@林夏#2 回头' },
    y: 800,
  })
  const named = await preview(server, id, dup)
  expect(named.unsent).toHaveLength(1)
  expect(named.unsent?.[0]).toMatchObject({
    name: '林夏#2',
    reason: 'no_image',
    message: '「林夏#2」没有可用图片，未送入',
  })
}, 30_000)

it('不同的断链 @ 逐条列出，同一个断链 @ 写两次只报一次', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const n = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '@幽灵道具 和 @幽灵场景，再看 @幽灵道具' },
    y: 400,
  })
  const input = await preview(server, id, n)
  // 两个不同的断链引用是两处不同的引用：各自一条，不合并
  const broken = (input.unsent ?? []).filter((item) => item.reason === 'mention_broken')
  expect(broken.map((item) => item.name)).toEqual(['幽灵道具', '幽灵场景'])
  // 同一个断链 @ 写两次：只保留一条
  expect(input.unsent).toHaveLength(2)
  for (const item of broken) expect(item.message).toContain(`@${item.name}`)
}, 30_000)

it('不收参考图的节点也给出 sent / unsent：@ 有图的卡明确说明不送入，连线的图如实列出', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const hero = card(doc, 'plein/character', '林夏', asset('a'), 0)
  const cases = [
    { type: 'plein/llm', params: { model: 'plein/mock:chat', prompt: '@林夏 是谁' } },
    { type: 'plein/image-edit', params: { model: 'plein/mock:image', prompt: '@林夏 改一下' } },
    {
      type: 'plein/speech',
      params: { model: 'plein/mock:audio', text: '@林夏 说一句' },
    },
    {
      type: 'plein/storyboard',
      params: { model: 'plein/mock:chat', prompt: '拆分 @林夏 的镜头' },
    },
  ] as const
  for (const item of cases) {
    const node = addNode(doc, item.type, { params: { ...item.params }, y: 400 })
    const input = await preview(server, id, node)
    // sent / unsent 必须存在（不再是 undefined）
    expect(input.sent).toEqual([])
    // @ 到有图的卡：看得见「没送入」，不静默
    expect(input.unsent).toContainEqual(
      expect.objectContaining({
        elementId: hero,
        name: '林夏',
        reason: 'unsupported',
        message: '「林夏」当前节点不会送入 @ 引用的参考图',
      }),
    )
    // 提示词不出现编号
    expect(input.prompt).not.toMatch(/图\d|@image\d|图片\d/)
  }

  // LLM 连了图：sent 如实列出，并与执行器实际送入模型的一致（模型要支持看图才收图）
  const photo = await server.assets.ingest(
    'local',
    Readable.from([solidPng(32, 24, [80, 90, 100])]),
    {
      mime: 'image/png',
      name: 'a.png',
    },
  )
  const llm = addNode(doc, 'plein/llm', {
    params: { model: 'plein/mock:agent-vision', prompt: '看图说话' },
    y: 800,
  })
  const image = imgEl(doc, 'a.png', photo.id, 300)
  connect(doc, [image, 'image'], [llm, 'images'])
  const connected = await preview(server, id, llm)
  expect(connected.sent).toEqual([
    expect.objectContaining({
      index: 1,
      token: '图1',
      assetId: photo.id,
      elementId: image,
      name: 'a.png',
      origins: ['edge'],
    }),
  ])
  expect(connected.inputs.images?.map((value) => value.assetId)).toEqual([photo.id])
  const seen: Array<{ messages?: Array<{ content: unknown }> }> = []
  const submit = mockProvider.submit
  vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
    seen.push(req.input as { messages?: Array<{ content: unknown }> })
    return submit.call(mockProvider, req, ctx)
  })
  const res = await run(server, id, llm, connected.inputHash)
  expect(res.status).toBe(202)
  const { runId } = (await res.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  const content = seen[0]!.messages?.at(-1)!.content as Array<{
    type: string
    image?: { assetId: string }
  }>
  expect(
    content.filter((part) => part.type === 'image').map((part) => part.image?.assetId),
  ).toEqual([photo.id])
}, 30_000)

it('上游文本引用同一张卡的不同档案项 / 视角：未送入逐条列出', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  // 角色档案：两个时期都没有图
  const hero = card(doc, 'plein/character', '林夏', null, 0)
  setParams(doc, hero, {
    profile: {
      periods: [
        { id: 'p-child', name: '童年', images: [] },
        { id: 'p-adult', name: '青年', images: [] },
      ],
      expressions: [],
    },
  })
  // 场景：两个视角的图都不存在
  addNode(doc, 'plein/scene', {
    name: '天台',
    params: {
      description: '天台',
      sceneViews: [
        { id: 'view-front', name: '正面', images: [asset('a')] },
        { id: 'view-back', name: '背面', images: [asset('b')] },
      ],
    },
    x: 300,
  })
  // 两条上游文本，@ 已被解析阶段改写，预览时找不到原始引用
  const textProfile = addNode(doc, 'plein/text', {
    params: { text: '@林夏/童年 和 @林夏/青年' },
    y: -600,
  })
  const textScene = addNode(doc, 'plein/text', {
    params: { text: '@天台/正面 和 @天台/背面' },
    x: 400,
    y: -600,
  })
  const image = addNode(doc, 'plein/image', {
    params: { model: 'plein/mock:image', prompt: '开拍' },
    y: 400,
  })
  connect(doc, [textProfile, 'text'], [image, 'prompt'])
  connect(doc, [textScene, 'text'], [image, 'prompt'])

  const input = await preview(server, id, image)
  expect(input.sent).toEqual([])
  // 身份来自解析阶段写在明细上的档案项 / 视角身份：不再合并成一条
  expect(input.unsent?.map((item) => item.name)).toEqual([
    '林夏（童年）',
    '林夏（青年）',
    '天台（正面）',
    '天台（背面）',
  ])
  for (const item of input.unsent ?? []) {
    expect(item.message).toContain(`「${item.name}」`)
    expect(item.reason).toBe('no_image')
  }
}, 30_000)

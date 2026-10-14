import {
  connect,
  createDoc,
  createElement,
  currentResult,
  type PleinDoc,
  setParams,
} from '@plein/doc'
import { ProviderError } from '@plein/plugin-sdk'
import type { BatchItem, JobInfo } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import sharp from 'sharp'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vite-plus/test'
import type { Server } from '../app'
import {
  addNode,
  bootServer,
  createCanvas as canvas,
  mockSettings as mock,
  request as call,
  until,
} from '../testing'

afterEach(() => {
  vi.restoreAllMocks()
})

const boot = () => bootServer()

const job = (server: Server, canvasId: string, id: string) =>
  server.runs.list(canvasId).jobs.find((j) => j.id === id)!

const status = (server: Server, id: string) => server.runs.store.get(id)?.status

async function recover(server: Server, canvasId: string, jobId: string, body: object) {
  const res = await call(server, `/api/canvases/${canvasId}/jobs/${jobId}/recover`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as JobInfo & { error?: string } }
}

/** 平台受理了提交，但回应在路上丢了 */
function loseSubmitResponse() {
  const real = mockProvider.submit
  let remoteId: string | undefined
  const submit = vi.spyOn(mockProvider, 'submit')
  submit.mockImplementationOnce(async (req, ctx) => {
    const r = await real(req, ctx)
    if (r.state === 'pending') remoteId = r.remoteId
    throw new ProviderError('unavailable', '网络断开', { outcome: 'unknown' })
  })
  return { submit, remoteId: () => remoteId }
}

/** 这个测试里 mock 平台不提供按幂等键查询 */
function withoutLookup() {
  const lookup = mockProvider.lookup
  mockProvider.lookup = undefined
  onTestFinished(() => {
    mockProvider.lookup = lookup
  })
}

/** 先跑出一个结果，返回它的 id */
async function firstResult(server: Server, canvasId: string, doc: PleinDoc, node: string) {
  mock(server, { latencyMs: 0 })
  const run = server.runs.start(canvasId, node, 'local')
  expect(await server.runs.wait(run)).toBe('succeeded')
  await until(() => !server.runs.isRunning(canvasId, node))
  return currentResult(doc.get(node)!)!.id
}

describe('提交状态未知', () => {
  it('平台有查询合同：按幂等键查到任务，接着取结果，不重复提交', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 200 })
    const { submit } = loseSubmitResponse()
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc.get(a)?.results).toHaveLength(1)
    expect(job(server, id, run).recovery?.state).toBe('adopted')
  })

  it('查询查不到、平台又不幂等：不自动重提，仍交给用户核查', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 200 })
    // 平台查询有延迟：刚受理的任务暂时查不到
    vi.spyOn(mockProvider, 'lookup').mockResolvedValue(null)
    const { submit } = loseSubmitResponse()
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(job(server, id, run).recovery?.state).toBe('submit_unknown')
  })

  it('没有查询合同：不显示完成、不自动重提；填平台任务 ID 后接着取结果', async () => {
    withoutLookup()
    const { server } = await boot()
    mock(server, { latencyMs: 200 })
    const lost = loseSubmitResponse()
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect(doc.get(a)?.results).toBeUndefined()
    expect(doc.get(a)?.run?.errorCode).toBe('submit_unknown')
    expect(job(server, id, run).recovery).toMatchObject({
      state: 'submit_unknown',
      verifiable: false,
      attachable: true,
    })
    // 不能重新获取（没有可核查的合同），任务 ID 要填
    expect((await recover(server, id, run, { action: 'refetch' })).status).toBe(400)
    const r = await recover(server, id, run, { action: 'attach', remoteId: lost.remoteId() })
    expect(r.status).toBe(200)
    await until(() => status(server, run) === 'succeeded')
    expect(lost.submit).toHaveBeenCalledTimes(1)
    expect(doc.get(a)?.results).toHaveLength(1)
    expect(doc.get(a)?.run).toMatchObject({ id: run, status: 'succeeded' })
  })

  it('人工确认未受理后重新提交；标记已处理后不再提示', async () => {
    withoutLookup()
    const { server } = await boot()
    mock(server, { latencyMs: 100 })
    const lost = loseSubmitResponse()
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const b = addNode(doc, 'plein/image', { params: { prompt: 'b', count: 1 }, x: 300 })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect((await recover(server, id, run, { action: 'resubmit' })).status).toBe(200)
    await until(() => status(server, run) === 'succeeded')
    expect(lost.submit).toHaveBeenCalledTimes(2)

    loseSubmitResponse()
    const other = server.runs.start(id, b, 'local')
    expect(await server.runs.wait(other)).toBe('failed')
    const r = await recover(server, id, other, { action: 'dismiss' })
    expect(r.body.recovery).toMatchObject({ state: 'submit_unknown', dismissed: true })
  })

  it('提交时服务退出：重启后按幂等键核查，提交次数不增加', async () => {
    const first = await boot()
    mock(first.server, { latencyMs: 200 })
    const real = mockProvider.submit
    const submit = vi.spyOn(mockProvider, 'submit').mockImplementationOnce(async (req, ctx) => {
      await real(req, ctx)
      // 回应还没回来进程就退出了
      return new Promise(() => {})
    })
    const { id, doc } = await canvas(first.server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = first.server.runs.start(id, a, 'local')
    await until(() => first.server.runs.store.get(run)?.calls.includes('submitting'))
    first.close()

    const second = await bootServer({ dataDir: first.dataDir })
    const doc2 = createDoc(second.server.rooms.get(id).doc, { schedule: () => {} })
    expect(await second.server.runs.wait(run)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc2.get(a)?.results).toHaveLength(1)
  })
})

describe('远端成功、本地获取失败', () => {
  it('保存失败：不算完成；重新获取后入库，不重新提交', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 0 })
    const submit = vi.spyOn(mockProvider, 'submit')
    vi.spyOn(server.assets, 'ingest').mockRejectedValueOnce(new Error('磁盘已满'))
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect(doc.get(a)?.results).toBeUndefined()
    expect(doc.get(a)?.run?.errorCode).toBe('fetch_failed')
    expect(job(server, id, run).recovery).toMatchObject({
      state: 'fetch_failed',
      refetchable: true,
    })

    expect((await recover(server, id, run, { action: 'refetch' })).status).toBe(200)
    await until(() => status(server, run) === 'succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc.get(a)?.results).toHaveLength(1)
    expect(job(server, id, run).recovery?.state).toBe('adopted')
  })

  it('轮询一直失败、自动重试用完：平台已受理，可以重新获取，不重新提交', async () => {
    const { server } = await boot()
    ;(server.runs as unknown as { retryDelays: number[] }).retryDelays = [20, 20]
    mock(server, { latencyMs: 200 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const poll = mockProvider.poll!
    let broken = true
    vi.spyOn(mockProvider, 'poll').mockImplementation(async (remoteId, ctx) => {
      if (broken) throw new ProviderError('unavailable', '模拟轮询网络断开')
      return poll(remoteId, ctx)
    })
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect(job(server, id, run).recovery).toMatchObject({
      state: 'remote_pending',
      refetchable: true,
    })

    broken = false
    expect((await recover(server, id, run, { action: 'refetch' })).status).toBe(200)
    await until(() => status(server, run) === 'succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc.get(a)?.results).toHaveLength(1)
  })

  it('下载失败：结果地址过期时重新查询平台拿新地址，不重新提交', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 0 })
    server.plugins.registry
      .plugin('plein/mock')!
      .manifest.permissions.network.push('files.mock.test')
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#f00' },
    })
      .png()
      .toBuffer()
    const submit = vi
      .spyOn(mockProvider, 'submit')
      .mockResolvedValue({ state: 'pending', remoteId: 'r-1', pollAfterMs: 0 })
    let polls = 0
    vi.spyOn(mockProvider, 'poll').mockImplementation(async () => ({
      state: 'succeeded',
      outputs: [
        {
          type: 'file',
          kind: 'image',
          mime: 'image/png',
          url: `https://files.mock.test/a-${++polls}.png`,
        },
      ],
    }))
    const realFetch = globalThis.fetch
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith('https://files.mock.test/')) return realFetch(input, init)
      return url.endsWith('a-1.png')
        ? new Response('expired', { status: 403 })
        : new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(polls).toBe(2)
    expect(
      fetch.mock.calls.filter(([u]) =>
        String(u instanceof Request ? u.url : u).includes('files.mock.test'),
      ),
    ).toHaveLength(2)
    expect(doc.get(a)?.results).toHaveLength(1)
  })
})

describe('晚返回的结果', () => {
  it('取消后平台仍生成完：记为用户取消；取回的结果进候选，不覆盖当前结果', async () => {
    const { server } = await boot()
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const before = await firstResult(server, id, doc, a)
    mock(server, { latencyMs: 300 })
    // 平台取消不了正在生成的任务
    vi.spyOn(mockProvider, 'cancel').mockResolvedValue()
    const submit = vi.spyOn(mockProvider, 'submit')
    const run = server.runs.start(id, a, 'local')
    await until(() => server.runs.store.get(run)?.calls.includes('pending'))
    server.runs.cancel(id, a)
    expect(await server.runs.wait(run)).toBe('canceled')
    expect(job(server, id, run)).toMatchObject({
      canceledBy: 'user',
      recovery: { state: 'remote_pending', refetchable: true },
    })

    expect((await recover(server, id, run, { action: 'refetch' })).status).toBe(200)
    await until(
      () => job(server, id, run).recovery?.state === 'stored' && status(server, run) === 'canceled',
    )
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc.get(a)?.results).toHaveLength(2)
    expect(currentResult(doc.get(a)!)?.id).toBe(before)
    expect(job(server, id, run).recovery).toMatchObject({ state: 'stored', held: 'canceled' })
  })

  it('取消时提交请求在途、随后返回：入库待采用，任务仍是已取消', async () => {
    const { server } = await boot()
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const before = await firstResult(server, id, doc, a)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const real = mockProvider.submit
    vi.spyOn(mockProvider, 'submit').mockImplementationOnce(async (req, ctx) => {
      await gate
      return real(req, ctx)
    })
    const run = server.runs.start(id, a, 'local')
    await until(() => doc.get(a)?.run?.phase === 'submitting')
    server.runs.cancel(id, a)
    release()
    expect(await server.runs.wait(run)).toBe('canceled')
    expect(doc.get(a)?.results).toHaveLength(2)
    expect(currentResult(doc.get(a)!)?.id).toBe(before)
    expect(doc.get(a)?.run).toMatchObject({ id: run, status: 'canceled' })
    expect(job(server, id, run).recovery).toMatchObject({ state: 'stored', held: 'canceled' })
  })

  it('生成期间改了输入：结果进候选，当前结果不变', async () => {
    const { server } = await boot()
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const before = await firstResult(server, id, doc, a)
    mock(server, { latencyMs: 300 })
    const run = server.runs.start(id, a, 'local')
    await until(() => server.runs.store.get(run)?.calls.includes('pending'))
    setParams(doc, a, { prompt: '改过的' })
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(doc.get(a)?.results).toHaveLength(2)
    expect(currentResult(doc.get(a)!)?.id).toBe(before)
    expect(job(server, id, run).recovery).toMatchObject({ state: 'stored', held: 'input_changed' })
  })
})

describe('批准的计划', () => {
  it('排队期间改了输入：执行前复核不一致，不调用平台，需要重新审查', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 300 })
    ;(server.runs as unknown as { concurrency: number }).concurrency = 1
    const submit = vi.spyOn(mockProvider, 'submit')
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const b = addNode(doc, 'plein/image', { params: { prompt: 'b', count: 1 }, x: 300 })
    const first = server.runs.start(id, a, 'local')
    const seen = await server.runs.preview(id, b, 'local')
    const r = await server.runs.startChecked(id, b, 'local', seen.inputHash)
    if (!('runId' in r)) throw new Error('应当开始运行')
    expect(status(server, r.runId)).toBe('queued')
    setParams(doc, b, { prompt: '排队时改了' })
    expect(await server.runs.wait(first)).toBe('succeeded')
    expect(await server.runs.wait(r.runId)).toBe('failed')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc.get(b)?.run?.errorCode).toBe('input_changed')
    expect(job(server, id, r.runId).recovery?.state).toBe('review')
  })

  it('批次快照记下阶段与待解析依赖；执行中改了下游，下游不提交、等重新审查', async () => {
    const { server } = await boot()
    const { id, doc } = await canvas(server)
    const frame = createElement(doc, { kind: 'frame', x: -50, y: -50, w: 900, h: 400 })
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a' }, x: 0, parentId: frame })
    const b = addNode(doc, 'plein/image', { params: { prompt: 'b' }, x: 300, parentId: frame })
    const c = addNode(doc, 'plein/image', { params: { prompt: 'c' }, x: 600, parentId: frame })
    connect(doc, [a, 'images'], [b, 'references'])
    mock(server, { latencyMs: 0 })
    const run = async () => {
      const res = await call(server, `/api/canvases/${id}/frames/${frame}/run`, {
        method: 'POST',
        body: '{}',
      })
      return ((await res.json()) as { groupId: string }).groupId
    }
    const done = (g: string) =>
      until(() => {
        const s = server.runs.groupState(g, 'local')
        return s?.status !== 'running' && s
      })
    await done(await run())
    const oldA = currentResult(doc.get(a)!)!.id

    setParams(doc, a, { prompt: 'a2' })
    mock(server, { latencyMs: 400 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const g = await run()
    const items = async () =>
      (await (await call(server, `/api/runs/groups/${g}/items`)).json()) as BatchItem[]
    await until(() => server.runs.store.batchItems(g).length === 3)
    const snap = await items()
    expect(snap.find((i) => i.nodeId === a)).toMatchObject({ stage: 'run', deps: [] })
    expect(snap.find((i) => i.nodeId === a)?.inputHash).toMatch(/^v2:/)
    expect(snap.find((i) => i.nodeId === b)).toMatchObject({
      stage: 'run',
      deps: [{ nodeId: a, resultId: oldA }],
    })
    expect(snap.find((i) => i.nodeId === b)?.inputHash).toBeUndefined()
    expect(snap.find((i) => i.nodeId === c)).toMatchObject({ stage: 'reuse' })

    // 上游还在生成时改了下游的参数
    await until(() =>
      server.runs.store
        .get(snap.find((i) => i.nodeId === a)!.jobId ?? '')
        ?.calls.includes('pending'),
    )
    setParams(doc, b, { prompt: 'b 改了' })
    const state = await done(g)
    expect(state.summary).toMatchObject({ succeeded: 1, failed: 1, cached: 1 })
    expect(submit).toHaveBeenCalledTimes(1)
    const after = await items()
    expect(after.find((i) => i.nodeId === a)).toMatchObject({ outcome: 'succeeded' })
    expect(after.find((i) => i.nodeId === a)?.frozenHash).toMatch(/^v2:/)
    expect(after.find((i) => i.nodeId === b)?.outcome).toBe('review')
    expect(after.find((i) => i.nodeId === c)?.outcome).toBe('cached')
    expect(server.runs.list(id).groups.find((x) => x.id === g)?.review).toBe(1)
  })
})

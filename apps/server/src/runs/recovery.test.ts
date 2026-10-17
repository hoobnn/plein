import {
  addResults,
  MAX_RESULTS,
  connect,
  createDoc,
  createElement,
  currentResult,
  type PleinDoc,
  setParams,
} from '@plein/doc'
import { ProviderError } from '@plein/plugin-sdk'
import type { BatchItem, JobInfo, LatestNodeJobs } from '@plein/protocol'
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
    await until(() => !server.runs.isRunning(id, a))
    expect(() => server.runs.start(id, a, 'local')).toThrow('原任务尚待核查或取回')
    expect((await recover(server, id, run, { action: 'resubmit' })).status).toBe(200)
    await until(() => status(server, run) === 'succeeded')
    expect(lost.submit).toHaveBeenCalledTimes(2)

    loseSubmitResponse()
    const other = server.runs.start(id, b, 'local')
    expect(await server.runs.wait(other)).toBe('failed')
    await until(() => !server.runs.isRunning(id, b))
    const r = await recover(server, id, other, { action: 'dismiss' })
    expect(r.body.recovery).toMatchObject({ state: 'submit_unknown', dismissed: true })
    const next = server.runs.start(id, b, 'local')
    expect(await server.runs.wait(next)).toBe('succeeded')
  })

  it.each(['attach', 'resubmit'] as const)(
    '节点已有新任务时拒绝 %s，保留原任务的调用记录和恢复状态',
    async (action) => {
      withoutLookup()
      const { server } = await boot()
      mock(server, { latencyMs: 0 })
      const realSubmit = mockProvider.submit
      const { submit } = loseSubmitResponse()
      const { id, doc } = await canvas(server)
      const node = addNode(doc, 'plein/image', { params: { prompt: '待核查的旧任务', count: 1 } })
      const original = server.runs.start(id, node, 'local')
      expect(await server.runs.wait(original)).toBe('failed')
      await until(() => !server.runs.isRunning(id, node))
      expect((await recover(server, id, original, { action: 'dismiss' })).status).toBe(200)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      submit.mockImplementationOnce(async (req, ctx) => {
        await gate
        return realSubmit(req, ctx)
      })
      const current = server.runs.start(id, node, 'local')
      try {
        await until(() => doc.get(node)?.run?.phase === 'submitting')
        const before = server.runs.store.get(original)!
        const response = await recover(server, id, original, {
          action,
          ...(action === 'attach' ? { remoteId: 'old-remote-id' } : {}),
        })
        expect(response).toMatchObject({ status: 409, body: { error: 'busy' } })
        expect(server.runs.store.get(original)).toEqual(before)
        expect(server.runs.isRunning(id, node)).toBe(true)
      } finally {
        server.runs.cancel(id, node)
        release()
        await server.runs.wait(current)
      }
      expect(status(server, current)).toBe('canceled')
    },
  )

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
    await first.close()

    const second = await bootServer({ dataDir: first.dataDir })
    const doc2 = createDoc(second.server.rooms.get(id).doc, { schedule: () => {} })
    expect(await second.server.runs.wait(run)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc2.get(a)?.results).toHaveLength(1)
  })
})

describe('远端成功、本地获取失败', () => {
  it.each(['fetch_failed', 'remote_pending'] as const)(
    '%s 无法重新查询时，明确标记已处理只解锁生成，不重提原任务',
    async (state) => {
      const { server } = await boot()
      mock(server, { latencyMs: 0 })
      const submit = vi.spyOn(mockProvider, 'submit')
      const { id, doc } = await canvas(server)
      const node = addNode(doc, 'plein/image', {
        params: { prompt: '放弃无法取回的结果', count: 1 },
      })
      server.runs.store.insert({
        id: 'unrefetchable',
        ownerId: 'local',
        canvasId: id,
        nodeId: node,
        nodeType: 'plein/image',
      })
      server.runs.store.update('unrefetchable', {
        status: 'failed',
        recovery: JSON.stringify({ state }),
      })
      expect(server.runs.latestForNodes(id, [node]).jobs[0]?.recovery).toMatchObject({
        state,
        refetchable: false,
      })
      expect(() => server.runs.start(id, node, 'local')).toThrow('原任务尚待核查或取回')
      const response = await recover(server, id, 'unrefetchable', { action: 'dismiss' })
      expect(response.status).toBe(200)
      expect(response.body.recovery).toMatchObject({ state, dismissed: true })
      expect(submit).not.toHaveBeenCalled()
      const next = server.runs.start(id, node, 'local')
      expect(await server.runs.wait(next)).toBe('succeeded')
      expect(submit).toHaveBeenCalledTimes(1)
      expect(doc.get(node)?.results).toHaveLength(1)
      expect(server.runs.store.get('unrefetchable')?.status).toBe('failed')
    },
  )

  it('超过 100 条其他任务仍按节点读到原恢复任务，普通生成被阻止，恢复不重复提交', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 0 })
    const submit = vi.spyOn(mockProvider, 'submit')
    vi.spyOn(server.assets, 'ingest').mockRejectedValueOnce(new Error('磁盘已满'))
    const { id, doc } = await canvas(server)
    const target = addNode(doc, 'plein/image', { params: { prompt: '待恢复镜头', count: 1 } })
    const noise = addNode(doc, 'plein/image', { params: { prompt: '其他镜头', count: 1 } })
    const original = server.runs.start(id, target, 'local')
    expect(await server.runs.wait(original)).toBe('failed')
    await until(() => !server.runs.isRunning(id, target))
    for (let i = 0; i < 105; i++) {
      const jobId = `latest-noise-${i}`
      server.runs.store.insert({
        id: jobId,
        ownerId: 'local',
        canvasId: id,
        nodeId: noise,
        nodeType: 'plein/image',
      })
      server.runs.store.update(jobId, { status: 'succeeded' })
    }
    const legacy = await call(server, `/api/canvases/${id}/jobs`)
    const legacyBody = (await legacy.json()) as { jobs: JobInfo[]; groups: unknown[] }
    expect(Object.keys(legacyBody).sort()).toEqual(['groups', 'jobs'])
    expect(legacyBody.jobs).toHaveLength(100)
    expect(legacyBody.jobs.some((job) => job.id === original)).toBe(false)
    const latest = async (nodes: string[]) =>
      call(server, `/api/canvases/${id}/jobs/latest`, {
        method: 'POST',
        body: JSON.stringify({ nodes }),
      })
    const response = await latest([target, noise, target, 'missing'])
    expect(response.status).toBe(200)
    expect(((await response.json()) as LatestNodeJobs).jobs).toMatchObject([
      { id: original, nodeId: target, recovery: { state: 'fetch_failed' } },
      { id: 'latest-noise-104', nodeId: noise },
    ])
    expect(((await (await latest([])).json()) as LatestNodeJobs).jobs).toEqual([])
    expect((await latest(Array.from({ length: 101 }, (_, i) => `node-${i}`))).status).toBe(400)
    const otherCanvas = await canvas(server)
    const isolation = await call(server, `/api/canvases/${otherCanvas.id}/jobs/latest`, {
      method: 'POST',
      body: JSON.stringify({ nodes: [target] }),
    })
    expect(((await isolation.json()) as LatestNodeJobs).jobs).toEqual([])
    const rejected = await call(server, `/api/canvases/${id}/nodes/${target}/run`, {
      method: 'POST',
      body: '{}',
    })
    expect(rejected.status).toBe(409)
    expect(((await rejected.json()) as { error: string }).error).toBe('recovery_required')
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await recover(server, id, original, { action: 'refetch' })).status).toBe(200)
    await until(() => status(server, original) === 'succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc.get(target)?.results).toHaveLength(1)
  })

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
  it('取消请求不是停机确认：核查前阻止新生成，原任务被平台确认结束后允许重新生成', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 20_000 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const { id, doc } = await canvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '取消后核查', count: 1 } })
    const original = server.runs.start(id, node, 'local')
    await until(() => server.runs.store.get(original)?.calls.includes('pending'))
    server.runs.cancel(id, node)
    expect(await server.runs.wait(original)).toBe('canceled')
    await until(() => !server.runs.isRunning(id, node))
    expect(job(server, id, original).recovery?.state).toBe('remote_pending')
    expect(() => server.runs.start(id, node, 'local')).toThrow('原任务尚待核查或取回')
    expect((await recover(server, id, original, { action: 'refetch' })).status).toBe(200)
    expect(await server.runs.wait(original)).toBe('failed')
    await until(() => !server.runs.isRunning(id, node))
    expect(job(server, id, original).recovery?.state).toBe('remote_failed')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(doc.get(node)?.run).toMatchObject({ id: original, status: 'failed' })
    mock(server, { latencyMs: 0 })
    const next = server.runs.start(id, node, 'local')
    expect(await server.runs.wait(next)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(2)
    expect(doc.get(node)?.results).toHaveLength(1)
  })

  it.each([1, MAX_RESULTS])(
    '取消后平台仍生成完：取回结果不覆盖当前采用（原记录 %s 条）',
    async (historySize) => {
      const { server } = await boot()
      const { id, doc } = await canvas(server)
      const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
      const before = await firstResult(server, id, doc, a)
      if (historySize > 1) {
        const original = currentResult(doc.get(a)!)!
        addResults(
          doc,
          a,
          Array.from({ length: historySize - 1 }, (_, i) => ({
            ...original,
            id: `candidate-${i}`,
            runId: `history-${i}`,
          })),
          { adopt: false },
        )
      }
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
        () =>
          job(server, id, run).recovery?.state === 'stored' && status(server, run) === 'canceled',
      )
      expect(submit).toHaveBeenCalledTimes(1)
      expect(doc.get(a)?.results).toHaveLength(Math.min(MAX_RESULTS, historySize + 1))
      expect(currentResult(doc.get(a)!)?.id).toBe(before)
      expect(job(server, id, run).recovery).toMatchObject({ state: 'stored', held: 'canceled' })
    },
  )

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

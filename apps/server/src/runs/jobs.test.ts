import { connect, createDoc, createElement, type PleinDoc, setParams } from '@plein/doc'
import { arrangeSequence, createSubtitleTrack, sequenceNode } from '@plein/nodes'
import type { JobList, RunActivity, StaleNodes } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Server } from '../app'
import { hasFfmpeg, mediaCaps } from '../assets/media'
import {
  addNode,
  bootServer,
  createCanvas as canvas,
  mockSettings as mock,
  mockModel,
  request as call,
  until,
  VIDEO_V1_PORTS,
} from '../testing'

afterEach(() => {
  vi.restoreAllMocks()
})

/** 测试里不等真实的退避时间 */
const fastRetry = (server: Server) => {
  ;(server.runs as unknown as { retryDelays: number[] }).retryDelays = [50, 50]
}

const boot = (env: NodeJS.ProcessEnv = {}) => bootServer({ env })

/** Frame：文本 → 图片 A → 图片 B，另有一个视频节点 */
function chain(doc: PleinDoc) {
  const frame = createElement(doc, { kind: 'frame', x: -50, y: -50, w: 1400, h: 400 })
  const parentId = frame
  const text = addNode(doc, 'plein/text', { params: { text: '天台 夜景' }, x: 0, parentId })
  const a = addNode(doc, 'plein/image', { x: 300, parentId })
  const b = addNode(doc, 'plein/image', { params: { prompt: '换个角度' }, x: 600, parentId })
  const video = addNode(doc, 'plein/video', {
    params: { prompt: '镜头推近' },
    ports: VIDEO_V1_PORTS,
    x: 900,
    parentId,
  })
  connect(doc, [text, 'text'], [a, 'prompt'])
  connect(doc, [a, 'images'], [b, 'references'])
  connect(doc, [b, 'images'], [video, 'firstFrame'])
  return { frame, text, a, b, video }
}

/** 等整组运行结束 */
const groupDone = (server: Server, groupId: string) =>
  until(() => {
    const s = server.runs.groupState(groupId, 'local')
    return s?.status !== 'running' && s
  })

async function runFrame(server: Server, canvasId: string, frame: string, body = {}) {
  const res = await call(server, `/api/canvases/${canvasId}/frames/${frame}/run`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(202)
  const { groupId, total } = (await res.json()) as { groupId: string; total: number }
  const state = await groupDone(server, groupId)
  return { groupId, total, status: state.status, summary: state.summary! }
}

describe('任务队列', () => {
  it('超过并发上限的任务排队，前一个结束后再开始', async () => {
    const { server } = await boot({ PLEIN_MAX_JOBS: '1' })
    mock(server, { latencyMs: 300 })
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a' } })
    const b = addNode(doc, 'plein/image', { params: { prompt: 'b' }, x: 300 })
    const ra = server.runs.start(id, a, 'local')
    server.runs.start(id, b, 'local')
    await until(() => doc.get(a)?.run?.status === 'running')
    expect(doc.get(b)?.run?.status).toBe('queued')
    expect(server.runs.store.get(ra)?.status).toBe('running')
    await until(() => doc.get(b)?.run?.status === 'running')
    expect(doc.get(a)?.run?.status).toBe('succeeded')
    await until(() => doc.get(b)?.run?.status === 'succeeded')
  })

  it('任务动态：队列计数、单个任务结束和整组结束', async () => {
    const { server } = await boot({ PLEIN_MAX_JOBS: '1' })
    mock(server, { latencyMs: 100 })
    const { id, doc } = await canvas(server)
    const events: RunActivity[] = []
    server.runs.onActivity((e) => events.push(e))
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a' } })
    const b = addNode(doc, 'plein/image', { name: '镜头 2', params: { prompt: 'b' }, x: 300 })
    server.runs.start(id, a, 'local')
    server.runs.start(id, b, 'local')
    await until(() => events.filter((e) => e.type === 'job-finished').length === 2)
    await until(() => {
      const last = events.findLast((e) => e.type === 'jobs')
      return last?.type === 'jobs' && last.running + last.queued === 0
    })
    expect(events).toContainEqual({ type: 'jobs', queued: 1, running: 1, progress: undefined })
    const finished = events.filter((e) => e.type === 'job-finished')
    expect(finished.map((e) => [e.nodeId, e.status])).toEqual([
      [a, 'succeeded'],
      [b, 'succeeded'],
    ])
    expect(finished[1]!.title).toBe('镜头 2')

    const { frame } = chain(doc)
    const { groupId } = await runFrame(server, id, frame)
    const group = events.find((e) => e.type === 'group-finished')
    expect(group).toMatchObject({ canvasId: id, frameId: frame, status: 'done' })
    expect(events.filter((e) => e.type === 'job-finished' && e.groupId === groupId).length).toBe(2)
  })

  it('取消排队中的任务', async () => {
    const { server } = await boot({ PLEIN_MAX_JOBS: '1' })
    mock(server, { latencyMs: 300 })
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a' } })
    const b = addNode(doc, 'plein/image', { params: { prompt: 'b' }, x: 300 })
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
    fastRetry(server)
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a' } })
    const run = server.runs.start(id, a, 'local')
    await until(() => doc.get(a)?.run?.phase === 'retrying')
    expect(doc.get(a)?.run).toMatchObject({ message: '模拟限流', attempt: 1 })
    expect(doc.get(a)?.run?.retryAt).toBeGreaterThan(Date.now() - 1000)
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(server.runs.store.get(run)?.attempts).toBe(2)
  })

  it('不可重试的错误直接失败', async () => {
    const { server } = await boot()
    mock(server, { failWith: 'content_policy' })
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a' } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('failed')
    expect(server.runs.store.get(run)).toMatchObject({ attempts: 1, status: 'failed' })
    expect(doc.get(a)?.run?.error).toContain('content_policy')
    expect(doc.get(a)?.run?.errorCode).toBe('content_policy')
  })

  it('运行中写回调用平台的阶段：平台排队、生成、保存结果', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 800 })
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a' } })
    const phases: string[] = []
    doc.ydoc.on('afterTransaction', () => {
      const phase = doc.get(a)?.run?.phase
      if (phase && phases.at(-1) !== phase) phases.push(phase)
    })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(phases).toEqual(['submitting', 'queued', 'generating', 'saving'])
    expect(doc.get(a)?.run?.status).toBe('succeeded')
  })

  it('远端已受理后轮询临时出错：重试时接着轮询，不重复提交', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 300 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const poll = mockProvider.poll!
    let polls = 0
    vi.spyOn(mockProvider, 'poll').mockImplementation(async (remoteId, ctx) => {
      if (polls++ === 0) {
        const { ProviderError } = await import('@plein/plugin-sdk')
        throw new ProviderError('unavailable', '模拟轮询网络抖动')
      }
      return poll(remoteId, ctx)
    })
    fastRetry(server)
    const { id, doc } = await canvas(server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = server.runs.start(id, a, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(server.runs.store.get(run)?.attempts).toBe(2)
  })

  it('删除画布时停止它排队和运行中的任务', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 2_000 })
    const { id, doc } = await canvas(server)
    const node = () => addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const runs = Array.from({ length: 6 }, () => server.runs.start(id, node(), 'local'))
    await until(() => server.runs.store.get(runs[0]!)?.status === 'running')
    // 任务记录随画布级联删除，先拿到等待结果的 promise
    const done = Promise.all(runs.map((run) => server.runs.wait(run)))
    const res = await call(server, `/api/canvases/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    for (const status of await done) expect(status).toBe('canceled')
    expect(server.rooms.has(id)).toBe(false)
  })

  it('删除项目时停止其下各画布的任务', async () => {
    const { server } = await boot()
    mock(server, { latencyMs: 2_000 })
    const project = (await (
      await call(server, '/api/projects', { method: 'POST', body: JSON.stringify({ title: 'p' }) })
    ).json()) as { id: string; lastCanvasId: string }
    const second = (await (
      await call(server, '/api/canvases', {
        method: 'POST',
        body: JSON.stringify({ projectId: project.id }),
      })
    ).json()) as { id: string }
    const runs = [project.lastCanvasId, second.id].map((cv) => {
      const doc = createDoc(server.rooms.get(cv).doc, { schedule: () => {} })
      return server.runs.start(
        cv,
        addNode(doc, 'plein/image', { params: { prompt: 'a' } }),
        'local',
      )
    })
    await until(() => runs.every((r) => server.runs.store.get(r)?.status === 'running'))
    const done = Promise.all(runs.map((run) => server.runs.wait(run)))
    const res = await call(server, `/api/projects/${project.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(await done).toEqual(['canceled', 'canceled'])
    expect(server.rooms.has(second.id)).toBe(false)
    expect(() => server.rooms.get(second.id)).toThrow(/已删除/)
  })

  it('服务重启后接着轮询远端任务，不重复提交', async () => {
    const first = await boot()
    mock(first.server, { latencyMs: 600 })
    const submit = vi.spyOn(mockProvider, 'submit')
    const { id, doc } = await canvas(first.server)
    const a = addNode(doc, 'plein/image', { params: { prompt: 'a', count: 1 } })
    const run = first.server.runs.start(id, a, 'local')
    await until(() => first.server.runs.store.get(run)?.calls.includes('pending'))
    expect(submit).toHaveBeenCalledTimes(1)
    // 退出：任务保持“运行中”，调用记录保留
    await first.close()

    const second = await bootServer({ dataDir: first.dataDir })
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

  it('运行到此处、运行下游；参数改了标记需要重跑', async () => {
    const { server } = await boot()
    mock(server, {})
    const { id, doc } = await canvas(server)
    const { frame, a, b, video } = chain(doc)
    await runFrame(server, id, frame)
    const stale = async () =>
      (await (await call(server, `/api/canvases/${id}/stale`)).json()) as StaleNodes
    expect(await stale()).toEqual({ stale: [], upstream: [], kept: [] })

    // 改了 A 的参数：A 过期，B 跟着需要重跑；视频还没生成过，不标
    setParams(doc, a, { prompt: '黄昏' })
    expect(await stale()).toEqual({ stale: [a], upstream: [b], kept: [] })

    const flow = async (node: string, body: object) => {
      const res = await call(server, `/api/canvases/${id}/nodes/${node}/run-flow`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(202)
      const { groupId } = (await res.json()) as { groupId: string }
      return groupDone(server, groupId)
    }
    // 运行到 B：A 改过要重跑，B 输入变了跟着跑
    expect((await flow(b, { scope: 'upstream' })).summary).toMatchObject({
      succeeded: 2,
      cached: 0,
    })
    expect(await stale()).toEqual({ stale: [], upstream: [], kept: [] })
    // 再运行到 B：都没改动
    expect((await flow(b, { scope: 'upstream' })).summary).toMatchObject({
      succeeded: 0,
      cached: 2,
    })
    // 从 B 往下：B 总是重跑，视频没有结果也要跑；A 不在范围内
    const down = await flow(b, { scope: 'downstream' })
    expect(down.summary).toMatchObject({ succeeded: 2, cached: 0 })
    expect(doc.get(video)!.results).toHaveLength(1)

    const list = (await (await call(server, `/api/canvases/${id}/jobs`)).json()) as JobList
    expect(list.groups[0]).toMatchObject({ frameId: b, scope: 'downstream' })
  })

  it('上游失败时下游跳过', async () => {
    const { server } = await boot()
    mock(server, { failWith: 'content_policy' })
    const { id, doc } = await canvas(server)
    const { frame, b } = chain(doc)
    const r = await runFrame(server, id, frame)
    expect(r.summary).toMatchObject({ failed: 1, skipped: 1, succeeded: 0 })
    expect(doc.get(b)?.run).toBeUndefined()

    // 任务面板：失败的任务带错误，整组运行带汇总
    const res = await call(server, `/api/canvases/${id}/jobs`)
    expect(res.status).toBe(200)
    const list = (await res.json()) as JobList
    expect(list.jobs).toHaveLength(1)
    expect(list.jobs[0]).toMatchObject({ status: 'failed', groupId: r.groupId })
    expect(list.jobs[0]!.error).toBeTruthy()
    expect(list.groups[0]).toMatchObject({ id: r.groupId, frameId: frame, status: 'done' })
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
    const state = await groupDone(server, groupId)
    expect(state).toMatchObject({ status: 'canceled', summary: { canceled: 1, skipped: 1 } })
    expect(doc.get(a)?.run?.status).toBe('canceled')
    expect(doc.get(b)?.run).toBeUndefined()
  })

  it('Frame 或画布不存在时 404', async () => {
    const { server } = await boot()
    const { id } = await canvas(server)
    expect((await call(server, '/api/canvases/nope/jobs')).status).toBe(404)
    const res = await call(server, `/api/canvases/${id}/frames/nope/run`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(404)
  })
})

const ffmpeg = await hasFfmpeg()
const caps = await mediaCaps()

describe.skipIf(!ffmpeg)('序列导出', () => {
  /** Frame 里两个镜头接到序列节点上，配音连到对白 */
  async function setup(sequence: Record<string, unknown>, lines: string[]) {
    const { server } = await boot()
    mock(server, {})
    const { id, doc } = await canvas(server)
    const parentId = createElement(doc, { kind: 'frame', x: -50, y: -50, w: 1400, h: 900 })
    const video = (prompt: string, x: number) =>
      addNode(doc, 'plein/video', { params: { prompt }, ports: VIDEO_V1_PORTS, x, parentId })
    const v1 = video('推近', 0)
    const v2 = video('拉远', 300)
    const speech = lines.map((text, i) =>
      addNode(doc, 'plein/speech', { params: { text }, x: i * 300, y: 300, parentId }),
    )
    const seq = addNode(doc, 'plein/sequence', { params: sequence, x: 800, parentId })
    connect(doc, [v1, 'video'], [seq, 'clips'])
    connect(doc, [v2, 'video'], [seq, 'clips'])
    for (const s of speech) connect(doc, [s, 'audio'], [seq, 'dialogue'])
    const assetOf = (node: string) =>
      server.assets.get(
        'local',
        (doc.get(node)!.results![0]!.value as { assetId: string }).assetId,
      )!
    return { server, id, doc, frame: parentId, v1, v2, speech, seq, assetOf }
  }

  // 烧字幕需要 libass；本机没有时跳过，结构部分由「关掉字幕也能导出」覆盖
  it.skipIf(!caps.subtitles)(
    '整组运行含视频时最后导出：镜头按顺序拼接，配上对白和字幕',
    async () => {
      const { server, id, doc, frame, v1, speech, seq, assetOf } = await setup(
        { resolution: '720p' },
        ['你来了', '我等你很久了'],
      )
      const providerCall = vi.spyOn(server.plugins, 'call')
      const r = await runFrame(server, id, frame, { video: true })
      expect(doc.get(seq)?.run?.error).toBeUndefined()
      expect(r.summary).toMatchObject({ succeeded: 5, failed: 0 })
      expect(doc.get(seq)!.results![0]!.value).toMatchObject({ type: 'video', mime: 'video/mp4' })
      const clip = assetOf(v1)
      expect(assetOf(seq)).toMatchObject({ width: 720, height: 1280 })
      expect(assetOf(seq).duration).toBeCloseTo(clip.duration! * 2, 0)
      // 配音结果带台词，导出时用作字幕
      expect(doc.get(speech[0]!)!.results![0]!.value).toMatchObject({ caption: '你来了' })
      const transcriptions = () =>
        providerCall.mock.calls.filter(([capability]) => capability === 'audio.transcribe')
      expect(transcriptions()).toHaveLength(0)

      // 导出不隐式调识别；先显式识别、保存字幕轨，再用同一轨合成。
      setParams(doc, seq, { transition: '叠化', transitionDuration: 0.4, asrTiming: true })
      const missingModel = await runFrame(server, id, frame, { video: true })
      expect(missingModel.summary).toMatchObject({ succeeded: 0, failed: 1 })
      expect(doc.get(seq)?.run?.error).toContain('请先在序列编辑器识别全部对白')
      expect(transcriptions()).toHaveLength(0)

      const asrModel = mockModel('audio.transcribe')
      setParams(doc, seq, { model: asrModel })
      const inspection = await server.runs.inspect(
        doc,
        doc.get(seq)!,
        'local',
        new AbortController().signal,
      )
      const p = sequenceNode.params.parse(inspection.params)
      const arranged = arrangeSequence(p, inspection.inputs)
      const assetIds = arranged.flatMap((c) => (c.dialogue ? [c.dialogue.assetId] : []))
      const recognized = await call(server, '/api/media/subtitle-recognize', {
        method: 'POST',
        body: JSON.stringify({ model: asrModel, assetIds }),
      })
      expect(recognized.status).toBe(200)
      const { transcripts } = (await recognized.json()) as {
        transcripts: Parameters<typeof createSubtitleTrack>[3]
      }
      const track = createSubtitleTrack(
        p,
        arranged,
        {
          clips: arranged.map((c) => server.assets.get('local', c.clip.assetId)!.duration!),
          dialogue: arranged.map((c) =>
            c.dialogue ? server.assets.get('local', c.dialogue.assetId)!.duration : undefined,
          ),
        },
        transcripts,
      )
      setParams(doc, seq, { subtitleTrack: track })
      const again = await runFrame(server, id, frame, { video: true })
      expect(doc.get(seq)?.run?.error).toBeUndefined()
      expect(again.summary).toMatchObject({ succeeded: 1, failed: 0 })
      expect(assetOf(seq).duration).toBeCloseTo(clip.duration! * 2 - 0.4, 0)
      expect(transcriptions().length).toBe(new Set(assetIds).size)
    },
    60_000,
  )

  // 不依赖 libass：任何有 ffmpeg 的机器都要能导出，顺序与入出点按时间线来
  it('关掉字幕也能导出：镜头按连接顺序拼接，音轨混在一起', async () => {
    const { server, id, doc, frame, v1, v2, seq, assetOf } = await setup(
      { resolution: '720p', subtitles: false },
      ['你来了'],
    )
    const r = await runFrame(server, id, frame, { video: true })
    expect(r.summary).toMatchObject({ succeeded: 4, failed: 0 })
    expect((doc.get(seq)!.results![0]!.value as { mime: string }).mime).toBe('video/mp4')
    const clip = assetOf(v1)
    expect(assetOf(seq)).toMatchObject({ width: 720, height: 1280 })
    expect(assetOf(seq).duration).toBeCloseTo(clip.duration! * 2, 0)

    // 调换顺序并裁掉第二段的一半
    setParams(doc, seq, {
      subtitles: false,
      clips: [
        { source: v2, in: 0, out: clip.duration! / 2 },
        { source: v1, in: 0 },
      ],
    })
    const again = await runFrame(server, id, frame, { video: true })
    expect(again.summary).toMatchObject({ succeeded: 1, cached: 3 })
    expect(assetOf(seq).duration).toBeCloseTo(clip.duration! * 1.5, 0)
  }, 60_000)

  // 本机 ffmpeg 常常没编 libass（Homebrew 默认不带）：这时要在合成前说清楚，而不是甩一句滤镜错误
  it.skipIf(caps.subtitles)(
    '要烧字幕但本机 ffmpeg 没有 ass 滤镜：提前给出可执行的提示',
    async () => {
      const { server, id, doc, frame, seq } = await setup({ subtitles: true }, ['你来了'])
      const r = await runFrame(server, id, frame, { video: true })
      expect(r.summary).toMatchObject({ succeeded: 3, failed: 1 })
      expect(doc.get(seq)?.run?.error).toMatch(/不支持烧字幕/)
      expect(doc.get(seq)?.run?.error).toMatch(/libass/)
    },
    60_000,
  )
})

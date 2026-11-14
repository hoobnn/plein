import {
  addResults,
  adoptResult,
  connect,
  createDoc,
  createElement,
  currentResult,
  type PleinDoc,
  writeRun,
} from '@plein/doc'
import type { Canvas, PreparedInput } from '@plein/protocol'
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { addNode, mockSettings, startTestServer, until } from '../testing'

/** 等节点的运行状态满足条件 */
const waitFor = (doc: PleinDoc, id: string, done: (s?: string) => boolean) =>
  until(() => done(doc.get(id)?.run?.status) && doc.get(id)!)

describe('节点运行接口', () => {
  let base: string
  let server: Awaited<ReturnType<typeof startTestServer>>['server']

  beforeAll(async () => {
    ;({ base, server } = await startTestServer())
  })

  /** 新建画布，返回 id 和服务端房间的文档 */
  const newCanvas = async () => {
    const canvas = (await (
      await fetch(`${base}/api/canvases`, { method: 'POST', body: '{}' })
    ).json()) as Canvas
    return { canvas, doc: createDoc(server.rooms.get(canvas.id).doc, { schedule: () => {} }) }
  }

  it('文本节点连到生成图片：就地计算上游，结果和状态写回画布', async () => {
    const { canvas, doc } = await newCanvas()
    const text = addNode(doc, 'plein/text', { params: { text: '天台 夜景' }, h: 100 })
    const image = addNode(doc, 'plein/image', { params: { count: 2 }, x: 300 })
    connect(doc, [text, 'text'], [image, 'prompt'])

    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${image}/run`, {
      method: 'POST',
    })
    expect(res.status).toBe(202)
    const busy = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${image}/run`, {
      method: 'POST',
    })
    expect(busy.status).toBe(409)

    const el = await waitFor(doc, image, (s) => s === 'succeeded' || s === 'failed')
    expect(el.run?.error).toBeUndefined()
    expect(el.results).toHaveLength(2)
    expect(currentResult(el)?.value).toMatchObject({ type: 'image', mime: 'image/png' })
    expect(el.adopted).toBe(el.results![0]!.id)
  })

  it('上游生成节点没有结果时报错', async () => {
    const { canvas, doc } = await newCanvas()
    const a = addNode(doc, 'plein/image', { name: '角色图' })
    const b = addNode(doc, 'plein/image', { params: { prompt: '换个角度' }, x: 300 })
    connect(doc, [a, 'images'], [b, 'references'])
    await fetch(`${base}/api/canvases/${canvas.id}/nodes/${b}/run`, { method: 'POST' })
    const el = await waitFor(doc, b, (s) => s === 'failed' || s === 'succeeded')
    expect(el.run).toMatchObject({ status: 'failed' })
    expect(el.run?.error).toContain('角色图')
  })

  it('上游候选待采用时引导采用而非重新生成，采用后下游读取同一素材', async () => {
    const { canvas, doc } = await newCanvas()
    const a = addNode(doc, 'plein/image', { name: '角色图' })
    const b = addNode(doc, 'plein/image', { params: { prompt: '换个角度' }, x: 300 })
    addResults(
      doc,
      a,
      [
        {
          id: 'held',
          port: 'images',
          runId: 'held-run',
          at: 1,
          value: { type: 'image', assetId: 'held-asset' },
        },
      ],
      { adopt: false },
    )
    connect(doc, [a, 'images'], [b, 'references'])
    const input = () => fetch(`${base}/api/canvases/${canvas.id}/nodes/${b}/input`)
    const blocked = await input()
    expect(blocked.status).toBe(200)
    expect(await blocked.json()).toMatchObject({
      status: 'unprepared',
      blocked: [
        { code: 'prepare_failed', message: '上游节点「角色图」有候选待采用，请先查看并采用结果' },
      ],
    })
    expect(doc.get(a)?.run).toBeUndefined()
    expect(doc.get(b)?.run).toBeUndefined()
    adoptResult(doc, a, 'held')
    const ready = await input()
    expect(ready.status).toBe(200)
    const prepared = (await ready.json()) as PreparedInput
    expect(prepared.inputs.references).toMatchObject([
      { type: 'image', assetId: 'held-asset', source: a },
    ])
  })
  it('生成期间采用别的候选：新结果只进候选，不顶掉用户的选择', async () => {
    const { canvas, doc } = await newCanvas()
    mockSettings(server, { latencyMs: 1200 })
    const id = addNode(doc, 'plein/image', { params: { prompt: '同一份输入的两次生成' } })
    addResults(doc, id, [
      {
        id: 'old-a',
        port: 'images',
        runId: 'run-old-a',
        at: 1,
        value: { type: 'image', assetId: 'a'.repeat(64) },
      },
      {
        id: 'old-b',
        port: 'images',
        runId: 'run-old-b',
        at: 2,
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    adoptResult(doc, id, 'old-a')

    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
      method: 'POST',
    })
    expect(res.status).toBe(202)
    // 受理之后、结果回来之前：用户改用另一个已有候选
    adoptResult(doc, id, 'old-b')

    const el = await waitFor(doc, id, (s) => s === 'succeeded' || s === 'failed')
    expect(el.run?.status).toBe('succeeded')
    // 用户的采用保留，新结果只进了候选
    expect(el.adopted).toBe('old-b')
    expect(el.results?.[0]?.runId).not.toBe('run-old-b')
    expect(server.runs.list(canvas.id).jobs.find((j) => j.nodeId === id)?.recovery).toMatchObject({
      state: 'stored',
      held: 'adopted_during_run',
    })
  })

  it('A→B→A：采用绕回同一结果也算人工改过，晚到结果不顶掉', async () => {
    const { canvas, doc } = await newCanvas()
    mockSettings(server, { latencyMs: 800 })
    const id = addNode(doc, 'plein/image', { params: { prompt: '绕回同一候选' } })
    addResults(doc, id, [
      {
        id: 'old-a',
        port: 'images',
        runId: 'run-old-a',
        at: 1,
        value: { type: 'image', assetId: 'a'.repeat(64) },
      },
      {
        id: 'old-b',
        port: 'images',
        runId: 'run-old-b',
        at: 2,
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    // 显式采用命令会写采用版本；旧画布没有这个字段
    const adopt = (resultId: string, revision: string) => {
      adoptResult(doc, id, resultId)
      doc.mutable(id)!.set('adoptionRevision', revision)
    }
    adopt('old-a', 'rev-1')

    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
      method: 'POST',
    })
    expect(res.status).toBe(202)
    // 生成期间先改用 B，又改回 A：采用的结果 id 和受理时一样，但选择确实变过
    adopt('old-b', 'rev-2')
    adopt('old-a', 'rev-3')

    const el = await waitFor(doc, id, (s) => s === 'succeeded' || s === 'failed')
    expect(el.run?.status).toBe('succeeded')
    expect(el.adopted).toBe('old-a')
    expect(server.runs.list(canvas.id).jobs.find((j) => j.nodeId === id)?.recovery).toMatchObject({
      state: 'stored',
      held: 'adopted_during_run',
    })
  })

  it('采用版本没变但结果 id 变了（旧客户端/撤销回另一候选）也保住人工选择', async () => {
    const { canvas, doc } = await newCanvas()
    mockSettings(server, { latencyMs: 800 })
    const id = addNode(doc, 'plein/image', { params: { prompt: '版本不变但改了采用' } })
    addResults(doc, id, [
      {
        id: 'same-rev-a',
        port: 'images',
        runId: 'run-same-rev-a',
        at: 1,
        value: { type: 'image', assetId: 'a'.repeat(64) },
      },
      {
        id: 'same-rev-b',
        port: 'images',
        runId: 'run-same-rev-b',
        at: 2,
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    // 受理时采用 A，采用版本 rev-1
    adoptResult(doc, id, 'same-rev-a')
    doc.mutable(id)!.set('adoptionRevision', 'rev-1')

    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
      method: 'POST',
    })
    expect(res.status).toBe(202)
    // 旧客户端或低层写入只改 adopted，不推进版本
    adoptResult(doc, id, 'same-rev-b')

    const el = await waitFor(doc, id, (s) => s === 'succeeded' || s === 'failed')
    expect(el.run?.status).toBe('succeeded')
    expect(el.adopted).toBe('same-rev-b')
    expect(server.runs.list(canvas.id).jobs.find((j) => j.nodeId === id)?.recovery).toMatchObject({
      state: 'stored',
      held: 'adopted_during_run',
    })
    // 采用版本保持低层写入的值，不被系统写回
    expect(doc.mutable(id)!.get('adoptionRevision')).toBe('rev-1')
  })

  it('旧画布没有采用版本时退回比较采用的结果 id', async () => {
    const { canvas, doc } = await newCanvas()
    mockSettings(server, { latencyMs: 800 })
    const id = addNode(doc, 'plein/image', { params: { prompt: '旧画布没有采用版本' } })
    addResults(doc, id, [
      {
        id: 'legacy-a',
        port: 'images',
        runId: 'run-legacy-a',
        at: 1,
        value: { type: 'image', assetId: 'a'.repeat(64) },
      },
      {
        id: 'legacy-b',
        port: 'images',
        runId: 'run-legacy-b',
        at: 2,
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    adoptResult(doc, id, 'legacy-a')

    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
      method: 'POST',
    })
    expect(res.status).toBe(202)
    adoptResult(doc, id, 'legacy-b')

    const el = await waitFor(doc, id, (s) => s === 'succeeded' || s === 'failed')
    expect(el.adopted).toBe('legacy-b')
    expect(server.runs.list(canvas.id).jobs.find((j) => j.nodeId === id)?.recovery).toMatchObject({
      state: 'stored',
      held: 'adopted_during_run',
    })
  })

  it('结果写回前的最后复核期间采用：仍保住人工选择', async () => {
    const { canvas, doc } = await newCanvas()
    mockSettings(server, { latencyMs: 0 })
    const id = addNode(doc, 'plein/image', { params: { prompt: '最后复核期间改采用' } })
    addResults(doc, id, [
      {
        id: 'late-a',
        port: 'images',
        runId: 'run-late-a',
        at: 1,
        value: { type: 'image', assetId: 'a'.repeat(64) },
      },
      {
        id: 'late-b',
        port: 'images',
        runId: 'run-late-b',
        at: 2,
        value: { type: 'image', assetId: 'b'.repeat(64) },
      },
    ])
    adoptResult(doc, id, 'late-a')

    // 卡在结果写回前的复核（第二次 prepare）上：这里正是采用可能被改的窗口
    const runs = server.runs as unknown as {
      prepare(
        doc: unknown,
        el: unknown,
        ownerId: string,
        signal: AbortSignal,
        canvasId?: string,
      ): Promise<unknown>
    }
    const real = runs.prepare.bind(runs)
    let calls = 0
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const reached = new Promise<void>((resolve) => (entered = resolve))
    const spy = vi.spyOn(runs, 'prepare').mockImplementation(async (...args) => {
      calls++
      if (calls === 2) {
        entered()
        await gate
      }
      return real(...args)
    })

    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
      method: 'POST',
    })
    expect(res.status).toBe(202)
    await reached
    adoptResult(doc, id, 'late-b')
    release()
    const el = await waitFor(doc, id, (s) => s === 'succeeded' || s === 'failed')
    spy.mockRestore()
    expect(el.run?.status).toBe('succeeded')
    expect(el.adopted).toBe('late-b')
    expect(server.runs.list(canvas.id).jobs.find((j) => j.nodeId === id)?.recovery).toMatchObject({
      state: 'stored',
      held: 'adopted_during_run',
    })
  })

  it('已有采用项时单节点重跑只进候选，不替用户更换当前结果', async () => {
    const { canvas, doc } = await newCanvas()
    mockSettings(server, { latencyMs: 0 })
    const id = addNode(doc, 'plein/image', { params: { prompt: '第一次生成' } })
    const first = server.runs.start(canvas.id, id, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')
    const adopted = doc.get(id)?.adopted
    expect(adopted).toBeTruthy()
    const older = doc.get(id)?.results?.[0]?.id
    await until(() => !server.runs.isRunning(canvas.id, id))

    const second = server.runs.start(canvas.id, id, 'local')
    expect(await server.runs.wait(second)).toBe('succeeded')
    await until(() => (doc.get(id)?.results?.length ?? 0) > 1)
    // 用户已经采用过的节点重跑：新结果只进候选，当前结果不变。
    expect(doc.get(id)?.adopted).toBe(adopted)
    expect(doc.get(id)?.results?.[0]?.id).not.toBe(older)
    expect(doc.get(id)?.results?.[0]?.id).not.toBe(adopted)
  })

  it('旧任务重试不能在节点已有新成功任务后再次提交', async () => {
    const { canvas, doc } = await newCanvas()
    const id = addNode(doc, 'plein/image', { params: { prompt: '已完成的水杯' } })
    const latest = server.runs.start(canvas.id, id, 'local')
    expect(await server.runs.wait(latest)).toBe('succeeded')
    const before = doc.get(id)?.results?.length
    const response = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retryOf: 'obsolete-failed-run' }),
    })
    expect(response.status).toBe(409)
    expect(doc.get(id)?.run).toMatchObject({ id: latest, status: 'succeeded' })
    expect(doc.get(id)?.results).toHaveLength(before!)
  })

  it('修复输入后可重试当前失败任务，同一旧重试不能重复生成', async () => {
    const { canvas, doc } = await newCanvas()
    const id = addNode(doc, 'plein/image', {
      params: { prompt: '透明水杯', model: 'not-installed:missing' },
    })
    const failed = server.runs.start(canvas.id, id, 'local')
    expect(await server.runs.wait(failed)).toBe('failed')
    const params = doc.mutable(id)!.get('params') as { set(key: string, value: unknown): void }
    params.set('model', 'plein/mock:image')
    const retry = () =>
      fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryOf: failed }),
      })
    const response = await retry()
    expect(response.status).toBe(202)
    const { runId } = (await response.json()) as { runId: string }
    expect(await server.runs.wait(runId)).toBe('succeeded')
    expect((await retry()).status).toBe(409)
    expect(doc.get(id)?.results).toHaveLength(1)
    expect(doc.get(id)?.run).toMatchObject({ id: runId, status: 'succeeded' })
  })

  it('损坏的重试参数不能降级为无条件生成', async () => {
    const { canvas, doc } = await newCanvas()
    const id = addNode(doc, 'plein/image')
    for (const body of ['{"retryOf":', '{"retryOf":12}', '{"retryOf":""}']) {
      const response = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(response.status).toBe(400)
      expect(doc.get(id)?.run).toBeUndefined()
    }
  })

  it('取消残留的运行中状态', async () => {
    const { canvas, doc } = await newCanvas()
    const id = addNode(doc, 'plein/image')
    writeRun(doc, id, { id: 'old', status: 'running', at: 1 })
    const res = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/cancel`, {
      method: 'POST',
    })
    expect(res.status).toBe(204)
    expect(doc.get(id)?.run?.status).toBe('canceled')
  })
  it('旧任务的停止请求不取消节点的新任务，匹配的请求仍可停止', async () => {
    const { canvas, doc } = await newCanvas()
    const id = addNode(doc, 'plein/image')
    writeRun(doc, id, { id: 'new-run', status: 'running', at: 1 })
    const cancel = (runId: string) =>
      fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      })
    const stale = await cancel('old-run')
    expect(stale.status).toBe(409)
    expect(doc.get(id)?.run).toMatchObject({ id: 'new-run', status: 'running' })
    expect((await cancel('new-run')).status).toBe(204)
    expect(doc.get(id)?.run).toMatchObject({ id: 'new-run', status: 'canceled' })
  })

  it('无效停止参数不能降级为不核对任务身份的取消', async () => {
    const { canvas, doc } = await newCanvas()
    const id = addNode(doc, 'plein/image')
    writeRun(doc, id, { id: 'kept-run', status: 'running', at: 1 })
    for (const body of ['{"runId":', '{"runId":12}', '{"runId":""}']) {
      const response = await fetch(`${base}/api/canvases/${canvas.id}/nodes/${id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(response.status).toBe(400)
      expect(doc.get(id)?.run).toMatchObject({ id: 'kept-run', status: 'running' })
    }
  })

  it('分镜节点：剧本拆成镜头写回参数', async () => {
    const { canvas, doc } = await newCanvas()
    const script = createElement(doc, {
      kind: 'markdown',
      text: '雨夜，林夏推开天台的门。她看见了陈默。两人对视。',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    const board = addNode(doc, 'plein/storyboard', { params: { shots: [] }, x: 300 })
    connect(doc, [script, 'text'], [board, 'script'])
    await fetch(`${base}/api/canvases/${canvas.id}/nodes/${board}/run`, { method: 'POST' })
    const el = await waitFor(doc, board, (s) => s === 'succeeded' || s === 'failed')
    expect(el.run?.error).toBeUndefined()
    const shots = el.params!.shots as Array<{ no: number; description: string; id: string }>
    expect(shots.map((s) => s.description)).toEqual([
      '雨夜，林夏推开天台的门',
      '她看见了陈默',
      '两人对视',
    ])
    expect(shots[0]!.id).toMatch(/^shot_/)
  })

  it('素材卡片不是节点，不能直接运行或作为流程起点', async () => {
    const { canvas, doc } = await newCanvas()
    const card = createElement(doc, {
      kind: 'markdown',
      text: '不是节点的卡片',
      x: 0,
      y: 0,
      w: 200,
      h: 100,
    })
    expect(() => server.runs.start(canvas.id, card, 'local')).toThrow('节点不存在')
    expect(() =>
      server.runs.runFlow(canvas.id, card, 'local', { scope: 'upstream', force: false }),
    ).toThrow('节点不存在')
  })

  it('设定卡是就地节点，没有可运行的批次', async () => {
    const { canvas, doc } = await newCanvas()
    const character = addNode(doc, 'plein/character', { params: { description: '设定' } })
    expect(() =>
      server.runs.runFlow(canvas.id, character, 'local', { scope: 'upstream', force: false }),
    ).toThrow('这里没有需要运行的节点')
  })
})

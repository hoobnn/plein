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
import { beforeAll, describe, expect, it } from 'vite-plus/test'
import { addNode, startTestServer, until } from '../testing'

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

import {
  connect,
  createDoc,
  createElement,
  currentResult,
  type PleinDoc,
  writeRun,
} from '@plein/doc'
import type { Canvas } from '@plein/protocol'
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
})

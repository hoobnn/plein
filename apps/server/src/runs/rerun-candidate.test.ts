import { Readable } from 'node:stream'
import { addResults, adoptResult, connect, createElement, currentResult } from '@plein/doc'
import { mockProvider } from '@plein/providers'
import { describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request, until } from '../testing'

/**
 * 已有采用项的节点被重新生成时，新结果只进候选，等用户确认再替换。
 *
 * 首次生成、明确批量运行的流水线、动态合成的审看策略都不变。
 */
describe('重跑已有采用的节点', () => {
  it('单节点重跑：新结果只进候选，当前采用保持不变', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '天台夜景' } })

    // 第一次生成：自动采用
    const first = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')
    const adopted = currentResult(doc.get(node)!)
    expect(adopted).toBeDefined()
    const adoptedId = adopted!.id

    // 重跑：新结果只进候选
    await until(() => !server.runs.isRunning(canvasId, node))
    const second = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(second)).toBe('succeeded')
    await until(() => (doc.get(node)!.results?.length ?? 0) > 1)

    // 当前采用仍是上一次的
    expect(doc.get(node)!.adopted).toBe(adoptedId)
    expect(currentResult(doc.get(node)!)!.id).toBe(adoptedId)
    // 新结果确实作为候选在历史里
    expect(doc.get(node)!.results!.length).toBeGreaterThan(1)
  })

  it('音效节点重跑同样只进候选', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/sfx', { params: { prompt: '雨声' } })

    const first = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')
    const adoptedId = currentResult(doc.get(node)!)!.id

    await until(() => !server.runs.isRunning(canvasId, node))
    const second = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(second)).toBe('succeeded')
    await until(() => (doc.get(node)!.results?.length ?? 0) > 1)

    expect(doc.get(node)!.adopted).toBe(adoptedId)
    expect(doc.get(node)!.results!.length).toBeGreaterThan(1)
  })

  it.each([
    ['plein/video', { model: 'plein/mock:video', prompt: '水杯', mode: 'text', duration: 2 }],
    ['plein/speech', { model: 'plein/mock:audio', text: '你好' }],
    ['plein/music', { model: 'plein/mock:audio', prompt: '紧张的弦乐' }],
    ['plein/sfx', { model: 'plein/mock:audio', prompt: '雨声' }],
  ] as const)('%s 重跑已有采用项同样只进候选', async (type, params) => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const node = addNode(doc, type, { params })

    const first = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')
    const adoptedId = currentResult(doc.get(node)!)!.id

    await until(() => !server.runs.isRunning(canvasId, node))
    const second = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(second)).toBe('succeeded')
    await until(() => (doc.get(node)!.results?.length ?? 0) > 1)

    expect(doc.get(node)!.adopted).toBe(adoptedId)
    expect(doc.get(node)!.results![0]!.id).not.toBe(adoptedId)
  })

  it('AI 图片加工已有采用项时重跑也只进候选', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const asset = await server.assets.ingest(
      'local',
      Readable.from([
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ]),
      { mime: 'image/png', name: '原图.png' },
    )
    const source = createElement(doc, {
      kind: 'image',
      assetId: asset.id,
      x: 0,
      y: 0,
      w: 64,
      h: 64,
    })
    const mask = await server.assets.ingest(
      'local',
      Readable.from([
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      ]),
      { mime: 'image/png', name: '蒙版.png' },
    )
    const node = addNode(doc, 'plein/image-edit', {
      params: {
        model: 'plein/mock:image-edit',
        prompt: '换成红杯子',
        mask: { assetId: mask.id, width: 1, height: 1, sourceAssetId: asset.id },
      },
    })
    connect(doc, [source, 'image'], [node, 'image'])

    const first = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')
    const adoptedId = currentResult(doc.get(node)!)!.id

    await until(() => !server.runs.isRunning(canvasId, node))
    const second = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(second)).toBe('succeeded')
    await until(() => (doc.get(node)!.results?.length ?? 0) > 1)

    expect(doc.get(node)!.adopted).toBe(adoptedId)
    expect(doc.get(node)!.results![0]!.id).not.toBe(adoptedId)
  })

  it('首次生成仍自动采用', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '天台夜景' } })
    const run = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(run)).toBe('succeeded')
    expect(doc.get(node)!.adopted).toBe(currentResult(doc.get(node)!)!.id)
    expect(doc.get(node)!.results).toHaveLength(1)
  })

  it('已采用的节点加了新候选后，手动采用仍然生效', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '天台夜景' } })
    const first = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')

    // 手工放一条候选
    addResults(
      doc,
      node,
      [
        {
          id: 'manual-candidate',
          port: 'images',
          runId: 'manual-run',
          at: Date.now(),
          value: { type: 'image', assetId: 'manual-asset' },
        },
      ],
      { adopt: false },
    )
    adoptResult(doc, node, 'manual-candidate')
    expect(currentResult(doc.get(node)!)!.id).toBe('manual-candidate')
  })
})

describe('恢复同一个重跑时沿用受理时的采用策略', () => {
  async function refetch(
    server: Awaited<ReturnType<typeof bootServer>>['server'],
    canvasId: string,
    jobId: string,
  ) {
    const res = await request(server, `/api/canvases/${canvasId}/jobs/${jobId}/recover`, {
      method: 'POST',
      body: JSON.stringify({ action: 'refetch' }),
    })
    expect(res.status).toBe(200)
    return res.json()
  }

  const jobOf = (
    server: Awaited<ReturnType<typeof bootServer>>['server'],
    canvasId: string,
    id: string,
  ) => server.runs.list(canvasId).jobs.find((j) => j.id === id)!

  it('已有采用的重跑取回失败后 refetch：仍只进候选，不覆盖原采用、不增加平台提交', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '已有采用的重跑' } })
    const first = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(first)).toBe('succeeded')
    const adoptedId = currentResult(doc.get(node)!)!.id
    await until(() => !server.runs.isRunning(canvasId, node))

    const submit = vi.spyOn(mockProvider, 'submit')
    vi.spyOn(server.assets, 'ingest').mockRejectedValueOnce(new Error('磁盘已满'))
    const second = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(second)).toBe('failed')
    await until(() => !server.runs.isRunning(canvasId, node))
    const callsBefore = submit.mock.calls.length
    const recoveryBefore = jobOf(server, canvasId, second).recovery
    expect(recoveryBefore?.state).toBe('fetch_failed')

    await refetch(server, canvasId, second)
    await until(() => jobOf(server, canvasId, second).status === 'succeeded')

    // 受理时的采用凭据仍是那次采用；返回时没有人工改动
    expect(JSON.parse(server.runs.store.get(second)!.adoption!)).toEqual(
      expect.objectContaining({ result: adoptedId }),
    )
    expect(doc.get(node)!.adopted).toBe(adoptedId)
    expect(currentResult(doc.get(node)!)!.id).toBe(adoptedId)
    // 新结果作为候选可见，但没有被自动采用
    expect(doc.get(node)!.results!.length).toBe(2)
    expect(doc.get(node)!.results![0]!.id).not.toBe(adoptedId)
    const recovery = jobOf(server, canvasId, second).recovery
    expect(recovery).toMatchObject({ state: 'stored', held: 'candidate_only' })
    // 取回没有重新提交平台
    expect(submit.mock.calls.length).toBe(callsBefore)
  })

  it('全新节点首次取回失败后 refetch：继续自动采用，只有一条候选', async () => {
    const { server } = await bootServer()
    const { id: canvasId, doc } = await createCanvas(server)
    const node = addNode(doc, 'plein/image', { params: { prompt: '首次取回' } })
    const submit = vi.spyOn(mockProvider, 'submit')
    vi.spyOn(server.assets, 'ingest').mockRejectedValueOnce(new Error('磁盘已满'))
    const only = server.runs.start(canvasId, node, 'local')
    expect(await server.runs.wait(only)).toBe('failed')
    await until(() => !server.runs.isRunning(canvasId, node))
    const callsBefore = submit.mock.calls.length

    await refetch(server, canvasId, only)
    await until(() => jobOf(server, canvasId, only).status === 'succeeded')

    expect(doc.get(node)!.results).toHaveLength(1)
    expect(doc.get(node)!.adopted).toBe(doc.get(node)!.results![0]!.id)
    expect(jobOf(server, canvasId, only).recovery).toMatchObject({ state: 'adopted' })
    expect(submit.mock.calls.length).toBe(callsBefore)
  })
})

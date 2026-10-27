// @vitest-environment happy-dom
import { connect, createElement, setParam, updateElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { Catalog, JobInfo } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mediaTestEngine } from './testEngine'
import { TranscriptionSplitPlan } from './TranscriptionSplitPlan'

resetStoreAfterEach(useCatalog)
let doc: PleinDoc
afterEach(() => doc?.destroy())
function setup() {
  doc = openDoc()
  const source = createElement(doc, { kind: 'audio', assetId: 'source', x: 0, y: 0, w: 100, h: 80 })
  const asr = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/transcribe',
    ports: { inputs: [{ id: 'audio', type: 'audio', label: '音频' }], outputs: [] },
    x: 0,
    y: 100,
    w: 100,
    h: 80,
    adopted: 'result',
    results: [
      {
        id: 'result',
        runId: 'run',
        port: 'segments',
        at: 1,
        value: {
          type: 'json',
          value: {
            segments: [
              { start: 0.1, end: 0.5, text: '甲' },
              { start: 0.5, end: 0.9, text: '乙' },
            ],
          },
        },
      },
    ],
  })
  connect(doc, [source, 'audio'], [asr, 'audio'])
  const engine = mediaTestEngine(doc)
  useCanvas.setState({ engine, canvasId: 'canvas' })
  const job = {
    id: 'run',
    nodeId: asr,
    nodeType: 'plein/transcribe',
    status: 'succeeded',
    input: {
      v: 1,
      nodeId: asr,
      nodeType: 'plein/transcribe',
      status: 'ready',
      inputs: { audio: [{ type: 'audio', assetId: 'source' }] },
    },
  } as unknown as JobInfo
  const onPlan = vi.fn()
  const render = () =>
    renderApp(
      <TranscriptionSplitPlan
        engine={engine}
        target={{ elId: source, assetId: 'source', kind: 'audio' }}
        duration={2}
        onPlan={onPlan}
      />,
    )
  return { source, asr, job, onPlan, render }
}

it('核验冻结源音频后导入区间，重连节点不改变历史来源，也不自动加工', async () => {
  const f = setup()
  const requests = mockFetch((request) =>
    new URL(request.url).pathname === '/api/canvases/canvas/jobs/run'
      ? Response.json(f.job)
      : undefined,
  )
  const { user } = f.render()
  await user.click(await screen.findByRole('button', { name: '使用识别区间' }))
  expect(f.onPlan).toHaveBeenCalledWith('0.1 - 0.5\n0.5 - 0.9')
  act(() => {
    const other = createElement(doc, {
      kind: 'audio',
      assetId: 'other',
      x: 100,
      y: 0,
      w: 100,
      h: 80,
    })
    for (const edge of doc.edges()) if (edge.to[0] === f.asr) doc.edgeMap.delete(edge.id)
    connect(doc, [other, 'audio'], [f.asr, 'audio'])
    setParam(doc, f.asr, 'unrelated', 'changed')
    doc.flush()
  })
  await user.click(screen.getByRole('button', { name: '使用识别区间' }))
  expect(requests).toHaveBeenCalledTimes(1)
  expect([...doc.elements()]).toHaveLength(3)
})

it.each(['adoption', 'source', 'remove'])(
  '读取中 %s 变化时丢弃迟到历史，不允许导入旧区间',
  async (change) => {
    const f = setup()
    let release!: (response: Response) => void
    mockFetch((request) =>
      new URL(request.url).pathname === '/api/canvases/canvas/jobs/run'
        ? new Promise<Response>((resolve) => {
            release = resolve
          })
        : undefined,
    )
    f.render()
    await waitFor(() => expect(release).toBeDefined())
    act(() => {
      if (change === 'adoption') doc.mutable(f.asr)!.set('adopted', null)
      if (change === 'source') updateElement(doc, f.source, { assetId: 'other' })
      if (change === 'remove') doc.elementMaps.delete(f.asr)
      doc.flush()
    })
    release(Response.json(f.job))
    await waitFor(() => expect(screen.queryByText('正在核验识别结果的源音频…')).toBeNull())
    expect(screen.queryByRole('button', { name: '使用识别区间' })).toBeNull()
    expect(f.onPlan).not.toHaveBeenCalled()
  },
)

it('历史读取失败可重新读取，不能把其他音频的结果当成当前来源', async () => {
  const f = setup()
  let attempt = 0
  mockFetch((request) => {
    if (new URL(request.url).pathname !== '/api/canvases/canvas/jobs/run') return
    if (attempt++ === 0) return Response.json({ error: 'offline' }, { status: 503 })
    return Response.json({
      ...f.job,
      input: { ...f.job.input, inputs: { audio: [{ type: 'audio', assetId: 'other' }] } },
    })
  })
  const { user } = f.render()
  await screen.findByText(/来源无法确认/)
  await user.click(screen.getByRole('button', { name: '重新读取识别结果' }))
  await waitFor(() => expect(attempt).toBe(2))
  await screen.findByText(/来源无法确认/)
  expect(screen.queryByRole('button', { name: '使用识别区间' })).toBeNull()
})

it('创建识别草稿只建立节点和音频连线，不提交任务', async () => {
  const f = setup()
  useCatalog.setState({
    catalog: {
      nodes: [
        {
          type: 'plein/transcribe',
          version: 1,
          title: '语音识别',
          defaults: {},
          paramsSchema: { properties: {} },
          inputs: [{ id: 'audio', type: 'audio', label: '音频' }],
          outputs: [{ id: 'segments', type: 'json', label: '时间戳' }],
        },
      ],
    } as unknown as Catalog,
  })
  const requests = mockFetch((request) =>
    new URL(request.url).pathname === '/api/canvases/canvas/jobs/run'
      ? Response.json(f.job)
      : undefined,
  )
  const { user } = f.render()
  await screen.findByRole('button', { name: '使用识别区间' })
  await user.click(screen.getByRole('button', { name: '创建语音识别草稿' }))
  const draft = [...doc.elements()].find(
    (element) => element.nodeType === 'plein/transcribe' && element.id !== f.asr,
  )!
  expect(draft.results ?? []).toEqual([])
  expect(
    [...doc.edges()].some(
      (edge) => edge.from[0] === f.source && edge.to[0] === draft.id && edge.to[1] === 'audio',
    ),
  ).toBe(true)
  expect(
    requests.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
  ).toBe(true)
})

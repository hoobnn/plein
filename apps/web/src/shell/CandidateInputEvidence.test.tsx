// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  adoptResult,
  createElement,
  type NodeResult,
  type PleinDoc,
  setParam,
  updateElement,
} from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import type { Catalog, PreparedInput } from '@plein/protocol'
import { PREPARED_INPUT_VERSION } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../testing/fetch'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { CandidateInputEvidence } from './CandidateInputEvidence'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const plugin = {
  type: 'acme/imagegen',
  version: 1,
  title: '插件出图',
  capability: 'image.generate',
  executable: true,
  inputs: [],
  outputs: [],
  defaults: {},
} as unknown as Catalog['nodes'][number]

const catalog = {
  providers: [],
  nodes: [plugin],
  templates: [],
  prompts: [],
  plugins: [],
} as unknown as Catalog

function prepared(nodeId: string): PreparedInput {
  return {
    v: PREPARED_INPUT_VERSION,
    nodeId,
    nodeType: 'acme/imagegen',
    preparedAt: 1,
    status: 'ready',
    inputs: {},
    params: {},
    refs: [],
    blocked: [],
    notices: [],
  }
}

/**
 * 第三方 image.generate 插件节点 + 指向本画布生成节点的绑定，目标画布还有一个同名普通图：
 * 参考模式下 @图 由绑定解析（同名图不算引用），能力来源必须与生成器一致。
 */
function setup(options: { catalog: Catalog | null } = { catalog }) {
  vi.useFakeTimers()
  const doc = openDoc()
  docs.push(doc)
  const engine = { doc } as Engine
  const look = createElement(doc, box({ name: '图', assetId: 'c'.repeat(64) }))
  const source = createElement(
    doc,
    node({
      nodeType: 'plein/image',
      name: '来源生成器',
      params: { prompt: '来源' },
      ports: {
        inputs: [],
        outputs: [{ id: 'images', label: '图片', type: 'image' }],
      },
    }),
  )
  addResults(doc, source, [
    {
      id: 'src-a',
      port: 'images',
      runId: 'run-src-a',
      at: 1,
      value: { type: 'image', assetId: 'n'.repeat(64) },
    },
    {
      id: 'src-b',
      port: 'images',
      runId: 'run-src-b',
      at: 2,
      value: { type: 'image', assetId: 'o'.repeat(64) },
    },
  ])
  const consumer = createElement(doc, {
    kind: 'node',
    nodeType: 'acme/imagegen',
    nodeVersion: 1,
    name: '插件节点',
    x: 0,
    y: 0,
    w: 120,
    h: 80,
    params: {
      prompt: '@图 出图',
      model: 'acme/mock',
      [`referenceNameBinding:${encodeURIComponent('图')}:${source}`]: {
        type: 'image',
        assetId: 'n'.repeat(64),
        source,
        sourcePort: 'images',
      },
    },
    ports: { inputs: [], outputs: [{ id: 'images', label: '图片', type: 'image' }] },
  })
  setParam(doc, consumer, 'prompt', '@图 出图')
  doc.flush()
  const result: NodeResult = {
    id: 'res-1',
    port: 'images',
    runId: 'run-1',
    at: 1,
    value: { type: 'image', assetId: 'a'.repeat(64) },
  }
  const input = prepared(consumer)
  const requests: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/canvases/canvas/jobs/run-1')
      return Response.json({
        id: 'run-1',
        nodeId: consumer,
        nodeType: 'acme/imagegen',
        status: 'succeeded',
        attempts: 1,
        createdAt: 1,
        input,
      })
    if (request.method === 'POST' && path === `/api/canvases/canvas/nodes/${consumer}/input`) {
      requests.push(path)
      return Response.json(input)
    }
    return undefined
  })
  const view = renderApp(
    <CandidateInputEvidence
      engine={engine}
      canvasId="canvas"
      viewer={{ kind: 'result', nodeId: consumer, resultId: 'res-1', name: '候选' } as never}
      result={result}
      catalog={options.catalog}
    />,
  )
  const open = async () => {
    await view.user.click(screen.getByText('此候选生成时输入与当前输入对照'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await waitFor(() => expect(requests).toHaveLength(1))
  }
  return { doc, engine, look, source, consumer, requests, open }
}

it('第三方 image.generate 插件节点与生成器同语义：同名普通图不算引用', async () => {
  const { doc, look, source, requests, open } = setup()
  await open()
  // 同名普通图换素材：绑定 token 由绑定解析，实际输入没变
  act(() => {
    updateElement(doc, look, { assetId: 'd'.repeat(64) })
    doc.flush()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  expect(requests).toHaveLength(1)
  // 绑定来源换采用：实际送入的素材变了，要重取
  act(() => {
    adoptResult(doc, source, 'src-b')
    doc.flush()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  expect(requests).toHaveLength(2)
})

it('拿不到能力来源时按非参考模式解析，同一张同名图变化会重取', async () => {
  // 对照：不传目录时无法确认插件是 image.generate，@图 按普通引用解析
  const { doc, look, requests, open } = setup({ catalog: null })
  await open()
  act(() => {
    updateElement(doc, look, { assetId: 'e'.repeat(64) })
    doc.flush()
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
  await waitFor(() => expect(requests).toHaveLength(2))
})

// @vitest-environment happy-dom
import { StrictMode } from 'react'
import type { Engine } from '@plein/canvas-core'
import { createElement, type PleinDoc, setParam } from '@plein/doc'
import { openDoc, node as makeNode } from '@plein/doc/testing'
import type { PreparedInput } from '@plein/protocol'
import { PREPARED_INPUT_VERSION } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen } from '../../testing/render'
import { mockFetch } from '../../testing/fetch'
import type { NodeInfo } from '../../canvas/nodes'
import { InputPreview, useInputPreview } from './InputPreview'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
const prepared = (nodeId: string, extra: Partial<PreparedInput> = {}): PreparedInput => ({
  v: PREPARED_INPUT_VERSION,
  nodeId,
  nodeType: 'test',
  preparedAt: 1,
  status: 'ready',
  params: {},
  inputs: {},
  refs: [],
  notices: [],
  blocked: [],
  ...extra,
})
const definition = {
  paramsSchema: {
    properties: {
      mode: { title: '生成模式', labels: { image: '图生视频', text: '文生视频' } },
      audio: { title: '生成音频' },
    },
  },
} as unknown as NodeInfo
function fixture() {
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(doc, makeNode({ name: '输入节点' }))
  doc.flush()
  return { doc, id, engine: { doc } as Engine }
}
function Harness({
  engine,
  id,
  canvas = 'canvas',
}: {
  engine: Engine
  id: string
  canvas?: string | null
}) {
  const preview = useInputPreview(engine, canvas, id)
  return (
    <>
      <InputPreview
        engine={engine}
        el={engine.doc.get(id)!}
        node={definition}
        {...preview}
        onRetry={preview.retry}
      />
      <output data-testid="stale">{String(preview.stale)}</output>
      <button
        type="button"
        onClick={() => preview.setData(prepared(id, { prompt: '提交返回的新输入' }))}
      >
        提交回执
      </button>
    </>
  )
}
const advance = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms))

it('StrictMode 首次立即读取，文档连续变化防抖，失败可重试且不提交生成', async () => {
  vi.useFakeTimers()
  const { engine, doc, id } = fixture()
  let failing = true
  const methods: string[] = []
  const requests = mockFetch((request) => {
    methods.push(request.method)
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/input'))
      return failing
        ? Response.json({ message: '输入服务暂不可用' }, { status: 503 })
        : Response.json(prepared(id, { prompt: '雨后的天台' }))
  })
  const { user } = renderApp(
    <StrictMode>
      <Harness engine={engine} id={id} />
    </StrictMode>,
  )
  await advance()
  expect(screen.getByRole('alert').textContent).toContain('输入服务暂不可用')
  expect(requests).toHaveBeenCalledTimes(1)
  failing = false
  await user.click(screen.getByRole('button', { name: '重新读取实际输入' }))
  await advance(399)
  expect(requests).toHaveBeenCalledTimes(1)
  await advance(1)
  await user.click(screen.getByRole('button', { name: /实际输入/ }))
  expect(screen.getByText('雨后的天台')).toBeTruthy()
  for (const prompt of ['a', 'ab', 'abc']) {
    act(() => {
      setParam(doc, id, 'prompt', prompt)
      doc.flush()
    })
    await advance(100)
  }
  expect(requests).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('stale').textContent).toBe('true')
  await advance(300)
  expect(requests).toHaveBeenCalledTimes(3)
  expect(methods).toEqual(['GET', 'GET', 'GET'])
})

it('失败保留上次输入但不显示旧阻断，新的提交回执取消在途预览且不被覆盖', async () => {
  vi.useFakeTimers()
  const { engine, doc, id } = fixture()
  let mode: 'initial' | 'fail' | 'pending' = 'initial'
  let release!: (response: Response) => void
  let signal!: AbortSignal
  mockFetch((request) => {
    if (!new URL(request.url).pathname.endsWith('/input')) return
    if (mode === 'initial')
      return Response.json(
        prepared(id, {
          prompt: '旧输入',
          blocked: [{ code: 'prepare_failed', message: '缺少必需参考' }],
        }),
      )
    if (mode === 'fail') return Response.json({ message: '刷新失败' }, { status: 503 })
    signal = request.signal
    return new Promise<Response>((resolve) => {
      release = resolve
    })
  })
  const { user } = renderApp(<Harness engine={engine} id={id} />)
  await advance()
  await user.click(screen.getByRole('button', { name: /实际输入/ }))
  expect(screen.getByText('不会提交')).toBeTruthy()
  mode = 'fail'
  act(() => {
    setParam(doc, id, 'prompt', '新输入')
    doc.flush()
  })
  await advance(400)
  expect(screen.getByRole('alert').textContent).toContain('上次读取的输入')
  expect(screen.queryByText('不会提交')).toBeNull()
  expect(screen.queryByText('缺少必需参考')).toBeNull()
  expect(screen.getByText('旧输入')).toBeTruthy()
  mode = 'pending'
  await user.click(screen.getByRole('button', { name: '重新读取实际输入' }))
  await advance(400)
  await user.click(screen.getByRole('button', { name: '提交回执' }))
  expect(signal.aborted).toBe(true)
  await act(async () => release(Response.json(prepared(id, { prompt: '迟到旧输入' }))))
  expect(screen.getByText('提交返回的新输入')).toBeTruthy()
  expect(screen.queryByText('迟到旧输入')).toBeNull()
})

it('换节点立即读取并取消旧请求，离开画布清除加载状态', async () => {
  vi.useFakeTimers()
  const { engine, doc, id } = fixture()
  const other = createElement(doc, makeNode())
  const pending: Array<{ signal: AbortSignal; resolve(response: Response): void }> = []
  mockFetch((request) =>
    new URL(request.url).pathname.endsWith('/input')
      ? new Promise<Response>((resolve) => pending.push({ signal: request.signal, resolve }))
      : undefined,
  )
  const view = renderApp(<Harness engine={engine} id={id} />)
  await advance()
  view.rerender(<Harness engine={engine} id={other} />)
  await advance()
  expect(pending).toHaveLength(2)
  expect(pending[0]!.signal.aborted).toBe(true)
  await act(async () => {
    pending[0]!.resolve(Response.json(prepared(id)))
    pending[1]!.resolve(Response.json(prepared(other, { prompt: '新节点' })))
  })
  view.rerender(<Harness engine={engine} id={other} canvas={null} />)
  expect(screen.queryByTestId('input-preview')).toBeNull()
})

it('同一资产来自两个节点时保留两个顺序项，参数显示标签与布尔文案', async () => {
  const { engine, doc, id } = fixture()
  const first = createElement(doc, makeNode({ name: '循环开场' }))
  const last = createElement(doc, makeNode({ name: '循环结束' }))
  const data = prepared(id, {
    params: { mode: 'image', audio: false },
    inputs: {
      images: [
        { type: 'image', assetId: 'shared', source: first },
        { type: 'image', assetId: 'shared', source: last },
      ],
    },
  })
  const errors = vi.spyOn(console, 'error')
  const view = renderApp(
    <InputPreview
      engine={engine}
      el={doc.get(id)!}
      node={definition}
      data={data}
      loading={false}
      error={null}
      onRetry={() => {}}
    />,
  )
  await view.user.click(screen.getByRole('button', { name: /实际输入/ }))
  expect(screen.getAllByRole('figure').map((el) => el.textContent)).toEqual([
    '1循环开场',
    '2循环结束',
  ])
  expect(screen.getByText('生成模式 图生视频')).toBeTruthy()
  expect(screen.getByText('生成音频 关闭')).toBeTruthy()
  view.rerender(
    <InputPreview
      engine={engine}
      el={doc.get(id)!}
      node={definition}
      data={{ ...data, params: { mode: 'text', audio: true } }}
      loading={false}
      error={null}
      onRetry={() => {}}
    />,
  )
  expect(screen.getByText('生成模式 文生视频')).toBeTruthy()
  expect(screen.getByText('生成音频 开启')).toBeTruthy()
  expect(screen.getAllByRole('figure')).toHaveLength(2)
  expect(errors.mock.calls.filter(([message]) => String(message).includes('same key'))).toEqual([])
})

it('提交回执在防抖计时中抵达时，不再发起已经过时的预览请求', async () => {
  vi.useFakeTimers()
  const { engine, doc, id } = fixture()
  const fetch = mockFetch((request) =>
    new URL(request.url).pathname.endsWith('/input') ? Response.json(prepared(id)) : undefined,
  )
  const { user } = renderApp(<Harness engine={engine} id={id} />)
  await advance()
  act(() => {
    setParam(doc, id, 'prompt', '更新输入')
    doc.flush()
  })
  await user.click(screen.getByRole('button', { name: '提交回执' }))
  await advance(400)
  expect(fetch).toHaveBeenCalledOnce()
  expect(screen.getByTestId('input-preview').getAttribute('aria-busy')).toBe('false')
})

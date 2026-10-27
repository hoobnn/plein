// @vitest-environment happy-dom
import { createElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { PREPARED_INPUT_VERSION, type Catalog, type PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { Generator } from '../features/generator/Generator'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { mockFetch } from '../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor, within } from '../testing/render'
import { mediaTestEngine } from './media-tools/testEngine'
import { ResultBar } from './ResultBar'

resetStoreAfterEach(useCatalog)

it('生成视频只为采用结果显示唯一工具入口，锁定后移至浮动栏，换素材关闭旧表单', async () => {
  const doc = openDoc()
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 0,
    w: 160,
    h: 90,
    params: { prompt: '镜头', mode: 'text' },
    adopted: null,
    results: [
      {
        id: 'one',
        runId: 'run1',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId: 'video1' },
      },
      {
        id: 'two',
        runId: 'run2',
        port: 'video',
        at: 2,
        value: { type: 'video', assetId: 'video2' },
      },
    ],
  })
  const engine = mediaTestEngine(doc)
  engine.selection.values = () => [id]
  engine.worldToClient = (x, y) => ({ x, y })
  useCanvas.setState({ engine, canvasId: 'canvas' })
  useCatalog.setState({
    catalog: {
      nodes: corePlugin.nodes.map((node) => ({
        ...describeNode(node, 'plein/core'),
        executable: true,
      })),
      providers: [],
      defaultModels: {},
      prompts: [],
      templates: [],
      elements: [],
      plugins: [],
    } as unknown as Catalog,
  })
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/media/caps') return Response.json({ ffmpeg: true })
    if (path.match(/^\/api\/assets\/video[12]\/meta$/))
      return Response.json({
        kind: 'video',
        width: path.includes('video1') ? 160 : 100,
        height: 90,
        duration: 3,
      })
    if (request.method === 'GET' && path === `/api/canvases/canvas/nodes/${id}/input`)
      return Response.json({
        v: PREPARED_INPUT_VERSION,
        nodeId: id,
        nodeType: 'plein/video',
        preparedAt: 1,
        status: 'ready',
        params: {},
        inputs: {},
        refs: [],
        blocked: [],
        notices: [],
      } satisfies PreparedInput)
  })
  const set = async (key: string, value: unknown) =>
    await act(async () => {
      doc.mutable(id)!.set(key, value)
      doc.flush()
    })
  let unmount = () => {}
  try {
    const view = renderApp(
      <>
        <Generator />
        <ResultBar />
      </>,
    )
    const { user } = view
    unmount = view.unmount
    expect(screen.queryByRole('button', { name: '媒体工具' })).toBeNull()
    await set('adopted', 'one')
    expect(screen.getAllByRole('button', { name: '媒体工具' })).toHaveLength(1)
    expect(
      within(screen.getByTestId('generator')).getByRole('button', { name: '媒体工具' }),
    ).toBeDefined()
    await user.click(screen.getByRole('button', { name: '媒体工具' }))
    await user.click(await screen.findByRole('button', { name: '裁剪' }))
    const width = screen.getByRole('textbox', { name: '宽' })
    await user.clear(width)
    await user.type(width, '80')
    await set('adopted', 'two')
    expect(screen.queryByRole('dialog', { name: '媒体工具' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '媒体工具' }))
    await user.click(await screen.findByRole('button', { name: '裁剪' }))
    expect((screen.getByRole('textbox', { name: '宽' }) as HTMLInputElement).value).toBe('100')
    await set('locked', true)
    expect(screen.queryByTestId('generator')).toBeNull()
    expect(screen.getAllByRole('button', { name: '媒体工具' })).toHaveLength(1)
    expect(
      within(screen.getByRole('toolbar', { name: '结果操作' })).getByRole('button', {
        name: '媒体工具',
      }),
    ).toBeDefined()
    await set('locked', false)
    expect(
      within(screen.getByTestId('generator')).getByRole('button', { name: '媒体工具' }),
    ).toBeDefined()
  } finally {
    unmount()
    doc.destroy()
  }
})

it('读取识别历史时替换音频会关闭旧弹层，迟到历史不能供新音频使用', async () => {
  const doc = openDoc()
  const source = createElement(doc, { kind: 'audio', assetId: 'audio1', x: 0, y: 0, w: 160, h: 90 })
  const asr = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/transcribe',
    x: 200,
    y: 0,
    w: 160,
    h: 90,
    adopted: 'result',
    results: [
      {
        id: 'result',
        runId: 'run',
        port: 'segments',
        at: 1,
        value: { type: 'json', value: { segments: [{ start: 0.1, end: 0.5, text: '甲' }] } },
      },
    ],
  })
  const engine = mediaTestEngine(doc)
  engine.selection.values = () => [source]
  engine.worldToClient = (x, y) => ({ x, y })
  useCanvas.setState({ engine, canvasId: 'canvas' })
  let release: (() => void) | undefined
  let reads = 0
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/media/caps') return Response.json({ ffmpeg: true })
    if (path.match(/^\/api\/assets\/audio[12]\/meta$/))
      return Response.json({ kind: 'audio', duration: 2 })
    if (path.endsWith('/jobs/run')) {
      if (reads++ === 0)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return Response.json({
        id: 'run',
        nodeId: asr,
        nodeType: 'plein/transcribe',
        status: 'succeeded',
        input: {
          nodeId: asr,
          nodeType: 'plein/transcribe',
          inputs: { audio: [{ type: 'audio', assetId: 'audio1' }] },
        },
      })
    }
  })
  try {
    const { user } = renderApp(<ResultBar />)
    const open = async () => {
      await user.click(screen.getByRole('button', { name: '媒体工具' }))
      await user.click(await screen.findByRole('button', { name: '手动切分' }))
    }
    await open()
    await waitFor(() => expect(release).toBeDefined())
    act(() => {
      doc.mutable(source)!.set('assetId', 'audio2')
      doc.flush()
    })
    expect(screen.queryByRole('dialog', { name: '媒体工具' })).toBeNull()
    await act(async () => {
      release!()
      await Promise.resolve()
    })
    await open()
    await screen.findByText(/没有可核验为当前音频的已采用识别结果/)
    expect(screen.queryByRole('button', { name: '使用识别区间' })).toBeNull()
    expect([...doc.elements()]).toHaveLength(2)
  } finally {
    release?.()
    doc.destroy()
  }
})

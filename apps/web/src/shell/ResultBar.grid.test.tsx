// @vitest-environment happy-dom
import { Camera, type Engine, Scene, Selection } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { mockFetch } from '../testing/fetch'
import { mockResizeObserver } from '../testing/browser'
import { ResultActions } from './ResultBar'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

it.each(['edit', 'back'] as const)(
  '切图等待中 %s 保留当前选择与镜头，只在点击定位后展示新组',
  async (action) => {
    mockResizeObserver()
    const doc = openDoc()
    docs.push(doc)
    const source = createElement(doc, {
      kind: 'image',
      assetId: 'source',
      x: 0,
      y: 0,
      w: 320,
      h: 240,
    })
    const other = createElement(doc, { kind: 'node', x: 800, y: 400, w: 320, h: 240 })
    const camera = new Camera()
    camera.setViewport(1200, 800)
    const selection = new Selection()
    selection.set([source])
    const engine = {
      doc,
      scene: new Scene(doc),
      camera,
      selection,
      state: { tool: 'select' },
      setTool: vi.fn(),
      zoomToFit: vi.fn(),
      onStateChange: () => () => {},
    } as unknown as Engine
    useCanvas.setState({ engine, canvasId: 'canvas' })
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 64, height: 48, close() {} })),
    )
    const context = { drawImage: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['tile'], { type: 'image/png' })),
    )
    let uploads = 0
    let release: (() => void) | undefined
    mockFetch((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/assets/source')
        return new Response(new Blob(['source'], { type: 'image/png' }))
      if (path === '/api/assets' && request.method === 'POST') {
        const id = `tile-${++uploads}`
        if (uploads === 4)
          return new Promise<Response>((resolve) => {
            release = () => resolve(Response.json({ id }, { status: 201 }))
          })
        return Response.json({ id }, { status: 201 })
      }
    })
    const { user } = renderApp(
      <>
        <ResultActions
          engine={engine}
          el={doc.get(source)!}
          media={{ assetId: 'source', kind: 'image' }}
          catalog={null}
          remote
          variant="bar"
        />
        <input aria-label="其他编辑" defaultValue="继续编辑" />
      </>,
    )
    await user.click(screen.getByRole('button', { name: '宫格切分' }))
    await user.click(screen.getByRole('button', { name: /4 宫格/ }))
    await waitFor(() => expect(uploads).toBe(4))
    act(() => selection.set([other]))
    if (action === 'edit')
      await user.type(screen.getByRole('textbox', { name: '其他编辑' }), '新内容')
    else act(() => selection.set([source]))
    const before = { ids: selection.values(), x: camera.x, y: camera.y, zoom: camera.zoom }
    await act(async () => release!())
    await waitFor(() => expect(useCanvas.getState().importing).toBeNull())
    expect({ ids: selection.values(), x: camera.x, y: camera.y, zoom: camera.zoom }).toEqual(before)
    expect(useCanvas.getState().notice).toBe('已完成 4 个镜头切分')
    if (action === 'edit')
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('继续编辑新内容')
    const frame = [...doc.elements()].find((el) => el.kind === 'frame')!
    const locate = useCanvas.getState().noticeAction!
    expect(locate.label).toBe('定位新素材')
    act(() => locate.run())
    expect(selection.values()).toEqual([frame.id])
  },
)

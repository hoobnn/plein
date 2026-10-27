// @vitest-environment happy-dom
import { createDoc, createElement } from '@plein/doc'
import * as Y from 'yjs'
import { beforeEach, expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { CheckpointPreview } from './CheckpointPreview'

const runtime = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  instances: [] as Array<{
    doc: ReturnType<typeof createDoc>
    destroy: ReturnType<typeof vi.fn>
    setTool: ReturnType<typeof vi.fn>
  }>,
}))
vi.mock('@plein/canvas-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plein/canvas-core')>()
  return {
    ...actual,
    Engine: class {
      camera = new actual.Camera()
      highDetail = true
      doc: ReturnType<typeof createDoc>
      get visibleIds() {
        return [...this.doc.elements()].map((el) => el.id)
      }
      constructor({ doc }: { doc: ReturnType<typeof createDoc> }) {
        this.doc = doc
        this.camera.setViewport(600, 400)
        runtime.instances.push(this)
      }
      init = () => runtime.init()
      destroy = vi.fn()
      setTool = vi.fn()
      onViewChange = () => () => {}
      zoomToFit = () => {}
    },
  }
})
beforeEach(() => {
  runtime.instances.length = 0
  runtime.init.mockReset().mockResolvedValue()
})
function snapshot(text: string) {
  const doc = createDoc()
  createElement(doc, {
    kind: 'node',
    nodeType: 'plein/text',
    name: '预览原稿',
    params: { text },
    x: 0,
    y: 0,
    w: 200,
    h: 100,
  })
  const state = btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc.ydoc)))
  doc.destroy()
  return state
}

it.each(['not-valid-base64!%', 'AQ=='])(
  '损坏状态 %s 局部报错，换有效快照恢复只读预览',
  async (state) => {
    const f = renderApp(<CheckpointPreview state={state} />)
    expect(screen.getByRole('alert').textContent).toContain('预览数据无法读取')
    expect(runtime.instances).toHaveLength(0)
    f.rerender(<CheckpointPreview state={snapshot('有效正文')} />)
    await screen.findByText(/有效正文/)
    expect(runtime.instances[0]!.doc.readOnly).toBe(true)
    expect(runtime.instances[0]!.setTool).toHaveBeenCalledWith('hand')
    expect(screen.queryByRole('alert')).toBeNull()
  },
)

it('切换快照与卸载分别销毁独立预览', async () => {
  const f = renderApp(<CheckpointPreview state={snapshot('第一版')} />)
  await screen.findByText(/第一版/)
  const first = runtime.instances[0]!
  f.rerender(<CheckpointPreview state={snapshot('第二版')} />)
  await screen.findByText(/第二版/)
  expect(first.destroy).toHaveBeenCalledTimes(1)
  f.unmount()
  expect(runtime.instances[1]!.destroy).toHaveBeenCalledTimes(1)
})

it('初始化尚未完成就关闭时，完成后释放资源且不安装交互', async () => {
  let finish!: () => void
  runtime.init.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const f = renderApp(<CheckpointPreview state={snapshot('等待初始化')} />)
  expect((screen.getByRole('button', { name: '适应画布' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  f.unmount()
  await act(async () => finish())
  expect(runtime.instances[0]!.destroy).toHaveBeenCalledTimes(1)
  expect(runtime.instances[0]!.setTool).not.toHaveBeenCalled()
})

it('初始化失败显示可恢复错误，换快照后可再次适应', async () => {
  runtime.init.mockRejectedValueOnce(new Error('初始化暂时失败'))
  const f = renderApp(<CheckpointPreview state={snapshot('第一版')} />)
  expect((await screen.findByRole('alert')).textContent).toContain('初始化暂时失败')
  f.rerender(<CheckpointPreview state={snapshot('第二版')} />)
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '适应画布' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  )
  expect(screen.queryByRole('alert')).toBeNull()
})

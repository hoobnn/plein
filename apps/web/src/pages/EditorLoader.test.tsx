// @vitest-environment happy-dom
import { StrictMode, type ComponentProps, useEffect } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen } from '../testing/render'
import { createEditorLoader } from './EditorLoader'

type EditorProps = ComponentProps<(typeof import('./Editor'))['Editor']>
function Editor({ source }: EditorProps) {
  return <div>{source.kind === 'remote' ? source.canvasId : `演示 ${source.count}`}</div>
}
const source = { kind: 'remote', canvasId: 'canvas-one' } as const
const props = { source, onOpenSettings: () => {} }
function deferred() {
  let resolve!: (module: { Editor: typeof Editor }) => void
  const promise = new Promise<{ Editor: typeof Editor }>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('首次加载显示状态，StrictMode 重放只发一次加载，完成即显示最新路由', async () => {
  const request = deferred()
  const load = vi.fn(() => request.promise)
  const Loader = createEditorLoader(load)
  const view = renderApp(
    <StrictMode>
      <Loader {...props} />
    </StrictMode>,
  )
  expect(screen.getByRole('status').textContent).toBe('正在打开工作区…')
  expect(load).toHaveBeenCalledTimes(1)
  view.rerender(
    <StrictMode>
      <Loader {...props} source={{ kind: 'remote', canvasId: 'canvas-two' }} />
    </StrictMode>,
  )
  await act(async () => request.resolve({ Editor }))
  expect(screen.getByText('canvas-two')).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  expect(load).toHaveBeenCalledTimes(1)
})

it('离开后迟到加载不挂载画布，重新进入直接复用已加载组件', async () => {
  const request = deferred()
  const load = vi.fn(() => request.promise)
  const mount = vi.fn()
  function ObservedEditor(props: EditorProps) {
    useEffect(mount, [])
    return <Editor {...props} />
  }
  const Loader = createEditorLoader(load)
  const view = renderApp(<Loader {...props} />)
  view.unmount()
  await act(async () => request.resolve({ Editor: ObservedEditor }))
  expect(mount).not.toHaveBeenCalled()
  renderApp(<Loader {...props} source={{ kind: 'demo', count: 12 }} />)
  expect(screen.getByText('演示 12')).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  expect(load).toHaveBeenCalledTimes(1)
  expect(mount).toHaveBeenCalledTimes(1)
})

it('加载失败显示原因，重试会重新请求并恢复画布', async () => {
  const load = vi
    .fn<() => Promise<{ Editor: typeof Editor }>>()
    .mockRejectedValueOnce(new Error('模块连接中断'))
    .mockResolvedValueOnce({ Editor })
  const Loader = createEditorLoader(load)
  const { user } = renderApp(<Loader {...props} />)
  expect((await screen.findByRole('alert')).textContent).toContain('模块连接中断')
  await user.click(screen.getByRole('button', { name: '重新打开' }))
  expect(await screen.findByText('canvas-one')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(load).toHaveBeenCalledTimes(2)
})

// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { confirmDialog, createDialogHost, dialogOpen, promptDialog } from './Dialog'

it.each(['confirm', 'prompt'] as const)(
  '%s 模块加载失败会取消操作、提示且下次能够重新打开',
  async (kind) => {
    const load = vi
      .fn<() => Promise<typeof import('./DialogView')>>()
      .mockRejectedValueOnce(new Error('模块连接中断'))
      .mockImplementation(() => import('./DialogView'))
    const Host = createDialogHost(load)
    const { user } = renderApp(
      <>
        <h1>项目列表</h1>
        <Host />
      </>,
      { dialogs: false },
    )
    const settled = vi.fn()
    act(() => {
      const result =
        kind === 'confirm'
          ? confirmDialog({ title: '删除项目' })
          : promptDialog({ title: '修改名称' })
      void result.then(settled)
    })
    expect((await screen.findByRole('alert')).textContent).toContain('操作已取消')
    await waitFor(() =>
      expect(settled).toHaveBeenCalledExactlyOnceWith(kind === 'confirm' ? false : null),
    )
    expect(dialogOpen()).toBe(false)
    expect(screen.getByRole('heading', { name: '项目列表' })).toBeTruthy()
    let next!: Promise<boolean>
    act(() => {
      next = confirmDialog({ title: '再次删除' })
    })
    await screen.findByRole('dialog', { name: '再次删除' })
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByRole('button', { name: '确定' }))
    await expect(next).resolves.toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
  },
)

it('等待模块时宿主卸载会取消请求，迟到失败不会重新打开提示', async () => {
  let reject!: (error: Error) => void
  const Host = createDialogHost(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      }),
  )
  const view = renderApp(<Host />, { dialogs: false })
  let result!: Promise<string | null>
  act(() => {
    result = promptDialog({ title: '修改名称' })
  })
  expect(screen.getByRole('status').textContent).toContain('正在打开对话框')
  view.unmount()
  await expect(result).resolves.toBeNull()
  await act(async () => reject(new Error('迟到的模块失败')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(dialogOpen()).toBe(false)
})

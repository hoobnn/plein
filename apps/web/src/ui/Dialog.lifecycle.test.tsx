// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../testing/render'
import { confirmDialog, dialogOpen, DialogHost, promptDialog } from './Dialog'

it('首次加载对话框期间取消会结算请求，不在加载完成后重新打开', async () => {
  const view = renderApp(<DialogHost />, { dialogs: false })
  let result!: Promise<boolean>
  act(() => {
    result = confirmDialog({ title: '删除项目' })
  })
  expect(dialogOpen()).toBe(true)
  view.rerender(<DialogHost active={false} />)
  await expect(result).resolves.toBe(false)
  expect(dialogOpen()).toBe(false)
  await act(async () => {
    await import('./DialogView')
  })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('异步提交的旧对话框迟到完成，不会关闭替换后的确认框', async () => {
  let complete!: () => void
  const pending = new Promise<void>((resolve) => {
    complete = resolve
  })
  const onConfirm = vi.fn(() => pending)
  const { user } = renderApp(<DialogHost />, { dialogs: false })
  let first!: Promise<string | null>
  act(() => {
    first = promptDialog({ title: '修改名称', defaultValue: '新名称', onConfirm })
  })
  const firstDialog = await screen.findByRole('dialog', { name: '修改名称' })
  await user.click(within(firstDialog).getByRole('button', { name: '确定' }))
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith('新名称')
  let next!: Promise<boolean>
  act(() => {
    next = confirmDialog({ title: '删除素材' })
  })
  await expect(first).resolves.toBeNull()
  await act(async () => complete())
  const current = await screen.findByRole('dialog', { name: '删除素材' })
  expect(dialogOpen()).toBe(true)
  await user.click(within(current).getByRole('button', { name: '确定' }))
  await expect(next).resolves.toBe(true)
})

it('提交失败保留输入和错误，重试成功才结算', async () => {
  const onConfirm = vi
    .fn()
    .mockRejectedValueOnce(new Error('连接中断'))
    .mockResolvedValueOnce(undefined)
  const { user } = renderApp(<DialogHost />, { dialogs: false })
  let result!: Promise<string | null>
  act(() => {
    result = promptDialog({ title: '修改名称', defaultValue: ' 初稿 ', onConfirm })
  })
  const dialog = await screen.findByRole('dialog', { name: '修改名称' })
  await user.click(within(dialog).getByRole('button', { name: '确定' }))
  expect((await screen.findByRole('alert')).textContent).toBe('连接中断')
  expect(within(dialog).getByRole<HTMLInputElement>('textbox').value).toBe(' 初稿 ')
  expect(dialogOpen()).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '确定' }))
  await expect(result).resolves.toBe('初稿')
  expect(onConfirm).toHaveBeenCalledTimes(2)
})

it('中文组字 Escape 保留对话框，普通 Escape 取消并关闭', async () => {
  renderApp(<DialogHost />, { dialogs: false })
  let result!: Promise<string | null>
  act(() => {
    result = promptDialog({ title: '输入名称' })
  })
  const input = within(await screen.findByRole('dialog')).getByRole('textbox')
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
  fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 })
  expect(dialogOpen()).toBe(true)
  fireEvent.keyDown(input, { key: 'Escape' })
  await expect(result).resolves.toBeNull()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

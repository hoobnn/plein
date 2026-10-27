// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen, waitFor } from '../testing/render'
import { confirmDialog, promptDialog } from './Dialog'

it.each([{ isComposing: true }, { keyCode: 229 }])(
  '输入对话框组字 Escape 保留草稿，取消后再次打开不复用旧草稿 %j',
  async (mode) => {
    const settled = vi.fn()
    const { user } = renderApp(
      <button
        type="button"
        onClick={() =>
          void promptDialog({
            title: '新建画布',
            defaultValue: '画布 2',
            placeholder: '画布名称',
          }).then(settled)
        }
      >
        新建
      </button>,
    )
    await user.click(screen.getByText('新建'))
    const input = screen.getByRole<HTMLInputElement>('textbox')
    expect(document.activeElement).toBe(input)
    expect(input.selectionEnd! - input.selectionStart!).toBe(input.value.length)
    await user.clear(input)
    await user.type(input, '未完成草稿')
    fireEvent.keyDown(input, { key: 'Escape', ...mode })
    expect(input.value).toBe('未完成草稿')
    expect(settled).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(settled).toHaveBeenCalledWith(null)
    await user.click(screen.getByText('新建'))
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('画布 2')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(settled).toHaveBeenLastCalledWith('画布 2')
  },
)

it('确认框取消不触发删除，新的对话框替换旧请求时旧请求按取消结算', async () => {
  renderApp(<div />)
  let old!: Promise<boolean>
  act(() => {
    old = confirmDialog({ title: '删除项目？', confirmLabel: '删除', danger: true })
  })
  let next!: Promise<string | null>
  act(() => {
    next = promptDialog({ title: '新建画布' })
  })
  await expect(old).resolves.toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  await expect(next).resolves.toBeNull()
})

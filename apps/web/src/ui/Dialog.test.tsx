// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen, waitFor } from '../testing/render'
import { choiceDialog, confirmDialog, promptDialog } from './Dialog'

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
    const input = await screen.findByRole<HTMLInputElement>('textbox')
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
  fireEvent.click(await screen.findByRole('button', { name: '取消' }))
  await expect(next).resolves.toBeNull()
})

it('三选一确认框区分第三个选项、确认与取消', async () => {
  const settled = vi.fn()
  const trigger = () =>
    void choiceDialog({
      title: '替换仍在使用的密钥？',
      message: '这组 Key 下有 2 个音色。',
      confirmLabel: '仍然替换',
      alternateLabel: '改为添加新组',
    }).then(settled)
  const { user } = renderApp(
    <button type="button" onClick={trigger}>
      保存
    </button>,
  )

  await user.click(screen.getByText('保存'))
  await user.click(await screen.findByRole('button', { name: '改为添加新组' }))
  await waitFor(() => expect(settled).toHaveBeenCalledWith('alternate'))

  await user.click(screen.getByText('保存'))
  await user.keyboard('{Escape}')
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith(false))

  await user.click(screen.getByText('保存'))
  await user.click(await screen.findByRole('button', { name: '仍然替换' }))
  await waitFor(() => expect(settled).toHaveBeenLastCalledWith(true))
})

it('三选一确认框可把初始焦点交给第三个选项，普通确认仍落在确认按钮', async () => {
  const { user } = renderApp(
    <button
      type="button"
      onClick={() =>
        void choiceDialog({
          title: '替换仍在使用的密钥？',
          confirmLabel: '仍然替换',
          alternateLabel: '改为添加新组',
          initialFocus: 'alternate',
        })
      }
    >
      替换
    </button>,
  )
  await user.click(screen.getByText('替换'))
  const alternate = await screen.findByRole('button', { name: '改为添加新组' })
  await waitFor(() => expect(document.activeElement).toBe(alternate))

  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  act(() => {
    void confirmDialog({ title: '删除密钥组？', confirmLabel: '删除', danger: true })
  })
  const confirm = await screen.findByRole('button', { name: '删除' })
  await waitFor(() => expect(document.activeElement).toBe(confirm))
})

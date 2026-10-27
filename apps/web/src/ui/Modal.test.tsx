// @vitest-environment happy-dom
import { useState } from 'react'
import { expect, it } from 'vite-plus/test'
import { fireEvent, renderApp, screen, waitFor } from '../testing/render'
import { Modal, ModalHeader } from './Modal'
import { Presence } from './Presence'
import { Select } from './Select'
import { MenuSelect } from './MenuSelect'

function Panels() {
  const [open, setOpen] = useState(false)
  const [top, setTop] = useState(false)
  const [value, setValue] = useState('a')
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Presence>
        {open && (
          <Modal label="编辑器" onClose={() => setOpen(false)} isolateKeys>
            <ModalHeader title="编辑器" onClose={() => setOpen(false)} />
            <input aria-label="正文" defaultValue="保留正文" />
            <Select
              aria-label="景别"
              value={value}
              onChange={setValue}
              options={[
                { value: 'a', label: '中景' },
                { value: 'disabled', label: '不可选', disabled: true },
                { value: 'b', label: '远景' },
              ]}
            />
            <MenuSelect
              label="筛选"
              value={value}
              onChange={setValue}
              options={[
                { value: 'a', label: '全部' },
                { value: 'b', label: '已生成' },
              ]}
            />
            <button type="button" onClick={() => setTop(true)}>
              设置
            </button>
          </Modal>
        )}
      </Presence>
      <Presence>
        {top && (
          <Modal label="设置" top isolateKeys onClose={() => setTop(false)}>
            <ModalHeader title="设置" onClose={() => setTop(false)} />
          </Modal>
        )}
      </Presence>
    </>
  )
}

it.each([{ isComposing: true }, { keyCode: 229 }, { consumed: true }])(
  '弹窗保留组字或已消费的 Escape，普通 Escape 恢复入口焦点 %j',
  async (mode) => {
    const { user } = renderApp(<Panels />)
    const trigger = screen.getByRole('button', { name: '打开' })
    await user.click(trigger)
    const close = screen.getByRole('button', { name: '关闭' })
    close.focus()
    if ('consumed' in mode)
      close.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
    fireEvent.keyDown(close, { key: 'Escape', ...mode })
    expect(screen.getByRole('dialog', { name: '编辑器' })).toBeTruthy()
    expect(document.activeElement).toBe(close)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  },
)

it('同级上层设置只消费一次 Escape，关闭后保留编辑器及原焦点', async () => {
  const { user } = renderApp(<Panels />)
  await user.click(screen.getByText('打开'))
  const settings = screen.getByRole('button', { name: '设置' })
  await user.click(settings)
  screen.getAllByRole('button', { name: '关闭' }).at(-1)!.focus()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '设置' })).toBeNull())
  expect(screen.getByRole('dialog', { name: '编辑器' })).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(settings))
})

it('内层编辑器消费 Escape 取消草稿后，下一次普通 Escape 才关闭父弹窗', async () => {
  function Editor() {
    const [open, setOpen] = useState(true)
    const [draft, setDraft] = useState('原名称')
    return (
      <Presence>
        {open && (
          <Modal label="改名面板" onClose={() => setOpen(false)}>
            <input
              aria-label="名称"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && draft !== '原名称') {
                  event.preventDefault()
                  setDraft('原名称')
                }
              }}
            />
          </Modal>
        )}
      </Presence>
    )
  }
  const { user } = renderApp(<Editor />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '名称' })
  await user.clear(input)
  await user.type(input, '未保存草稿')
  await user.keyboard('{Escape}')
  expect(screen.getByRole('dialog', { name: '改名面板' })).toBeTruthy()
  expect(input.value).toBe('原名称')
  expect(document.activeElement).toBe(input)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it.each(['{Enter}', ' ', '{Escape}'])('下拉键盘 %s 只处理当前选择，不关闭父编辑器', async (key) => {
  const { user } = renderApp(<Panels />)
  await user.click(screen.getByText('打开'))
  const trigger = screen.getByRole('combobox', { name: '景别' })
  await user.click(trigger)
  await user.keyboard('{End}')
  await user.keyboard(key)
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
  expect(trigger.textContent).toBe(key === '{Escape}' ? '中景' : '远景')
  expect(screen.getByRole('dialog', { name: '编辑器' })).toBeTruthy()
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('菜单触发器上的撤销被消费，普通输入框的撤销留给浏览器', async () => {
  const { user } = renderApp(<Panels />)
  await user.click(screen.getByText('打开'))
  const input = screen.getByRole('textbox', { name: '正文' })
  expect(fireEvent.keyDown(input, { key: 'z', ctrlKey: true })).toBe(true)
  const trigger = screen.getByRole('button', { name: '筛选' })
  await user.click(trigger)
  trigger.focus()
  for (const key of ['z', 'y'])
    expect(fireEvent.keyDown(trigger, { key, ctrlKey: true })).toBe(false)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(screen.getByRole('dialog', { name: '编辑器' })).toBeTruthy()
})

it('菜单选择保留筛选值，上层设置打开时菜单让位', async () => {
  const { user } = renderApp(<Panels />)
  await user.click(screen.getByText('打开'))
  const filter = screen.getByRole('button', { name: '筛选' })
  await user.click(filter)
  await user.click(screen.getByRole('menuitemradio', { name: '已生成' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  expect(filter.textContent).toContain('已生成')
  await user.click(filter)
  await user.click(screen.getByRole('button', { name: '设置' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await user.keyboard('{Escape}')
  expect(filter.textContent).toContain('已生成')
})

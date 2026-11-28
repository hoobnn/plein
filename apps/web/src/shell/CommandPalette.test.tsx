// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement } from '@plein/doc'
import { afterEach, expect, it } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { fireEvent, renderApp, screen, waitFor } from '../testing/render'
import { CommandPalette } from './CommandPalette'
import { LoadingPanel } from '../ui/LoadingPanel'

const docs: ReturnType<typeof createDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setup() {
  const doc = createDoc()
  docs.push(doc)
  const id = createElement(doc, { kind: 'markdown', text: '保留正文', x: 0, y: 0, w: 300, h: 100 })
  const engine = {
    doc,
    selection: { values: () => [id] },
    camera: { viewRect: { x: 0, y: 0, w: 1000, h: 800 } },
  } as unknown as Engine
  useCanvas.setState({ engine })
  return { ...renderApp(<CommandPalette canvasId={null} />), doc }
}

it.each(['', '没有匹配的命令'])('搜索为「%s」时一次 Escape 关闭，不改文档', async (query) => {
  const { user, doc } = setup()
  const before = [...doc.elements()]
  await user.keyboard('{Control>}k{/Control}')
  const input = screen.getByRole('combobox')
  if (query) await user.type(input, query)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect([...doc.elements()]).toEqual(before)
})

it.each([{ isComposing: true }, { keyCode: 229 }])(
  '组字快捷键不打开，导航确认和取消不执行或关闭 %j',
  async (mode) => {
    const { user, doc } = setup()
    const before = [...doc.elements()]
    expect(fireEvent.keyDown(window, { key: 'k', ctrlKey: true, ...mode })).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.keyboard('{Control>}k{/Control}')
    const input = screen.getByRole('combobox')
    const selected = input.getAttribute('aria-activedescendant')
    for (const key of ['ArrowDown', 'Enter', 'Escape']) fireEvent.keyDown(input, { key, ...mode })
    expect(input.getAttribute('aria-activedescendant')).toBe(selected)
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeTruthy()
    expect([...doc.elements()]).toEqual(before)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  },
)

it('焦点离开输入后 Escape 仍关闭，重新打开重置导航并聚焦', async () => {
  const { user } = setup()
  await user.keyboard('{Control>}k{/Control}')
  const dialog = screen.getByRole('dialog', { name: '命令面板' })
  dialog.focus()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await user.keyboard('{Control>}k{/Control}')
  const input = screen.getByRole('combobox')
  expect(document.activeElement).toBe(input)
  const active = input.getAttribute('aria-activedescendant')
  await user.keyboard('{ArrowDown}')
  expect(input.getAttribute('aria-activedescendant')).not.toBe(active)
})

it('输入和其他弹窗保留自己的快捷键，长按不重复切换面板', async () => {
  const { user } = setup()
  const loading = renderApp(<LoadingPanel label="正在打开设置…" />)
  expect(fireEvent.keyDown(document.body, { key: 'k', metaKey: true })).toBe(true)
  expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull()
  loading.unmount()
  const view = renderApp(
    <div role="dialog" aria-label="其他面板">
      <input aria-label="编辑名称" />
      <button type="button">保存</button>
    </div>,
  )
  for (const target of [
    screen.getByRole('textbox'),
    screen.getByRole('button', { name: '保存' }),
  ]) {
    target.focus()
    expect(fireEvent.keyDown(target, { key: 'k', ctrlKey: true })).toBe(true)
    expect(screen.queryByRole('dialog', { name: '命令面板' })).toBeNull()
  }
  view.unmount()
  await user.keyboard('{Control>}k{/Control}')
  const input = screen.getByRole('combobox', { name: '搜索命令' })
  fireEvent.keyDown(input, { key: 'k', ctrlKey: true, repeat: true })
  expect(screen.getByRole('dialog', { name: '命令面板' })).toBeTruthy()
  await user.keyboard('{Control>}k{/Control}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

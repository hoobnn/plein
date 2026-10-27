// @vitest-environment happy-dom
import { expect, it } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { fireEvent, renderApp, screen, waitFor, within } from '../testing/render'
import { Shortcuts } from './Shortcuts'

/** 面板挂在画布外壳里，与 store 联动即可，不依赖引擎 */
async function setup() {
  renderApp(<Shortcuts />)
  return {
    open: () => useCanvas.setState({ shortcuts: true }),
  }
}

it('按 ? 打开说明，Escape 关闭', async () => {
  const f = await setup()
  f.open()
  const dialog = await screen.findByRole('dialog', { name: '快捷键' })
  expect(within(dialog).getByText('快捷键面板')).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '快捷键' })).toBeNull())
})

it.each([
  ['组字中', { isComposing: true }],
  ['旧版 229 键码', { keyCode: 229 }],
  ['长按重复', { repeat: true }],
  ['Ctrl', { ctrlKey: true }],
  ['Meta', { metaKey: true }],
  ['Alt', { altKey: true }],
] as const)('%s 的问号不误开说明', async (_, props) => {
  await setup()
  fireEvent.keyDown(window, { key: '?', code: 'Slash', shiftKey: true, ...props })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(screen.queryByRole('dialog', { name: '快捷键' })).toBeNull()
  // 被其他处理器消费过的按键也不再打开
  const consumed = new KeyboardEvent('keydown', {
    key: '?',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  })
  consumed.preventDefault()
  fireEvent(window, consumed)
  expect(useCanvas.getState().shortcuts).toBe(false)
  // 正常问号仍可打开
  fireEvent.keyDown(window, { key: '?', shiftKey: true })
  await screen.findByRole('dialog', { name: '快捷键' })
})

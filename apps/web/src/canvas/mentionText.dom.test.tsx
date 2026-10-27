// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { fireEvent, renderApp, screen } from '../testing/render'
import { renderMentionText } from './mentionText'

it('卡片引用点击和键盘可定位，普通文字及失效引用不绑定目标', () => {
  renderApp(<div data-testid="body" />)
  const root = screen.getByTestId('body')
  const locate = vi.fn()
  const text = '看着@小岚；@已删除元素；test@example.com；\\@小岚'
  renderMentionText(root, text, [{ id: 'role', name: '小岚' }], locate)
  expect(root.textContent).toBe(text)
  const button = screen.getByRole('button', { name: '@小岚' })
  fireEvent.click(button)
  fireEvent.keyDown(button, { key: 'Enter' })
  fireEvent.keyDown(button, { key: ' ' })
  fireEvent.keyDown(button, { key: 'ArrowDown' })
  expect(locate.mock.calls).toEqual([['role'], ['role'], ['role']])
  expect(root.querySelectorAll('mark')).toHaveLength(2)
  expect(root.querySelector('[data-state="missing"]')?.getAttribute('role')).toBeNull()
  renderMentionText(root, text, [], locate)
  expect(screen.queryByRole('button')).toBeNull()
  expect(root.textContent).toBe(text)
})

// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { mockResizeObserver } from '../testing/browser'
import { fireEvent, renderApp, screen } from '../testing/render'
import { MentionTextarea } from './MentionTextarea'

it('引用只显示原文，悬停给出名称与编号', () => {
  mockResizeObserver()
  const text = '@叶 左手垫在头下'
  renderApp(
    <MentionTextarea
      aria-label="提示词"
      value={text}
      targets={[{ id: 'card', name: '叶' }]}
      references={{
        bindings: {},
        items: [],
        numbers: [
          {
            start: 0,
            end: 2,
            text: '@叶',
            name: '叶',
            id: 'card',
            labels: ['图片1'],
          },
        ],
      }}
      onChange={() => {}}
    />,
  )
  const mark = document.querySelector('[data-testid="mention-highlights"] mark')!
  // 正文镜像层只画用户写的原文，编号只放进悬停提示。
  expect(mark.textContent).toBe('@叶')
  expect(mark.querySelector('.plein-mention-badge')).toBeNull()
  expect(mark.getAttribute('data-title')).toBe('叶 → 图片1')
  vi.spyOn(mark, 'getClientRects').mockReturnValue([
    { left: 0, right: 20, top: 0, bottom: 20 },
  ] as unknown as DOMRectList)
  const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' })
  fireEvent.pointerMove(textarea, { clientX: 10, clientY: 10 })
  expect(textarea.title).toBe('叶 → 图片1')
})

it('一处引用对应多张图时，悬停提示完整写出每个编号', () => {
  mockResizeObserver()
  const text = '@叶舒 站在门口'
  renderApp(
    <MentionTextarea
      aria-label="提示词"
      value={text}
      targets={[{ id: 'card', name: '叶舒' }]}
      references={{
        bindings: {},
        items: [],
        numbers: [
          {
            start: 0,
            end: 3,
            text: '@叶舒',
            name: '叶舒',
            id: 'card',
            labels: ['图2', '图3', '图4'],
          },
        ],
      }}
      onChange={() => {}}
    />,
  )
  const mark = document.querySelector('[data-testid="mention-highlights"] mark')!
  expect(mark.textContent).toBe('@叶舒')
  expect(mark.getAttribute('data-title')).toBe('叶舒 → 图2、图3、图4')
})

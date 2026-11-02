// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { mockResizeObserver } from '../testing/browser'
import { fireEvent, renderApp, screen } from '../testing/render'
import { MentionTextarea } from './MentionTextarea'

it('短引用的编号徽标完整显示，悬停给出名称与编号', () => {
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
  // 徽标本身是完整的「图片1」，不再被原文占位的宽度裁成「图片」。
  expect(mark.querySelector('.plein-mention-badge')?.textContent).toBe('图片1')
  expect(mark.getAttribute('data-title')).toBe('叶 · 图片1')
  vi.spyOn(mark, 'getClientRects').mockReturnValue([
    { left: 0, right: 20, top: 0, bottom: 20 },
  ] as unknown as DOMRectList)
  const textarea = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' })
  fireEvent.pointerMove(textarea, { clientX: 10, clientY: 10 })
  expect(textarea.title).toBe('叶 · 图片1')
})

it('长文件名在编号徽标后显示去扩展名的淡色名称，原文占位保持不变', () => {
  mockResizeObserver()
  const file = '03-01-叶舒翻本说明日程_V007.png'
  const text = `首帧参考图 @${file} ，调度图`
  renderApp(
    <MentionTextarea
      aria-label="提示词"
      value={text}
      targets={[{ id: 'card', name: file }]}
      references={{
        bindings: {},
        items: [],
        numbers: [
          {
            start: text.indexOf('@'),
            end: text.indexOf('@') + file.length + 1,
            text: `@${file}`,
            name: file,
            id: 'card',
            labels: ['图片1'],
          },
        ],
      }}
      onChange={() => {}}
    />,
  )
  const mark = document.querySelector('[data-testid="mention-highlights"] mark')!
  expect(mark.querySelector('.plein-mention-raw')?.textContent).toBe(`@${file}`)
  expect(mark.querySelector('.plein-mention-name')?.textContent).toBe('03-01-叶舒翻本说明日程_V007')
  // 名称和徽标都叠在原文占位上，不额外撑开标记宽度。
  expect(mark.querySelector('.plein-mention-tags')).toBeTruthy()
})

it('跨行引用按第一行占位宽度设置名称层，宽度不再退化成 0', () => {
  mockResizeObserver()
  const file = 'wrap-reference-name.png'
  const text = `@${file}`
  renderApp(
    <MentionTextarea
      aria-label="提示词"
      value={text}
      targets={[{ id: 'card', name: file }]}
      references={{
        bindings: {},
        items: [],
        numbers: [
          {
            start: 0,
            end: file.length + 1,
            text,
            name: file,
            id: 'card',
            labels: ['图片1'],
          },
        ],
      }}
      onChange={() => {}}
    />,
  )
  const mark = document.querySelector('[data-testid="mention-highlights"] mark')!
  const raw = mark.querySelector('.plein-mention-raw')!
  vi.spyOn(raw, 'getClientRects').mockReturnValue([
    { width: 180, left: 0, right: 180, top: 0, bottom: 20 },
  ] as unknown as DOMRectList)
  fireEvent.scroll(screen.getByRole<HTMLTextAreaElement>('textbox', { name: '提示词' }))
  expect(mark.querySelector<HTMLElement>('.plein-mention-tags')?.style.width).toBe('180px')
})

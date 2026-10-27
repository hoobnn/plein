// @vitest-environment happy-dom
import { createRef } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { fireEvent, renderApp } from '../testing/render'
import { BoardTextPreview } from './BoardTextPreview'

it('引用点击、Enter 与空格定位对应目标，普通文字和邮箱不参与导航', () => {
  const locate = vi.fn()
  const source = createRef<HTMLButtonElement>()
  const { container } = renderApp(
    <>
      <button type="button" ref={source}>
        正文
      </button>
      <BoardTextPreview
        text="@小岚 @小岚#2 @不存在 test@example.com"
        targets={[
          { id: 'a', name: '小岚' },
          { id: 'b', name: '小岚' },
        ]}
        onLocate={locate}
        source={source}
      />
    </>,
  )
  const marks = container.querySelectorAll('mark')
  expect(marks).toHaveLength(3)
  expect(marks[0]!.getAttribute('role')).toBeNull()
  expect(marks[2]!.getAttribute('role')).toBeNull()
  expect(marks[1]!.dataset.mentionId).toBe('b')
  fireEvent.click(marks[1]!)
  fireEvent.keyDown(marks[1]!, { key: 'Enter' })
  fireEvent.keyDown(marks[1]!, { key: ' ' })
  expect(locate.mock.calls).toEqual([['b'], ['b'], ['b']])
  expect(container.textContent).toContain('test@example.com')
})
it('引用失效时把焦点还给正文标题，恢复目标后重新可导航', () => {
  const locate = vi.fn()
  const source = createRef<HTMLButtonElement>()
  // 这里只驱动可见性输入；真实两行裁切与键盘跳过由 core 浏览器用例证明。
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 200, 40))
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 100, 20),
  ] as unknown as DOMRectList)
  const view = (targets: Array<{ id: string; name: string }>) => (
    <>
      <button type="button" ref={source}>
        正文
      </button>
      <BoardTextPreview text="@小岚" targets={targets} onLocate={locate} source={source} />
    </>
  )
  const { container, rerender } = renderApp(view([{ id: 'a', name: '小岚' }]))
  const mark = container.querySelector('mark')!
  mark.focus()
  expect(document.activeElement).toBe(mark)
  rerender(view([]))
  expect(document.activeElement).toBe(source.current)
  expect(mark.getAttribute('role')).toBeNull()
  expect(mark.dataset.state).toBe('missing')
  fireEvent.click(mark)
  expect(locate).not.toHaveBeenCalled()
  rerender(view([{ id: 'a', name: '小岚' }]))
  fireEvent.click(mark)
  expect(locate).toHaveBeenCalledWith('a')
})

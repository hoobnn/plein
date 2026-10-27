// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen } from '../testing/render'
import { TooltipHost } from './Tooltip'

async function setup(label = '生成', explicit = false) {
  vi.useFakeTimers()
  renderApp(
    <>
      <button type="button" title={label} aria-label={explicit ? '固定名称' : undefined}>
        <svg />
      </button>
      <TooltipHost />
    </>,
  )
  const button = screen.getByRole('button')
  fireEvent.pointerOver(button, { pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(screen.getByRole('tooltip').textContent).toBe(label)
  return button
}

it('悬停期间更新操作，提示与自动补充的无障碍名称一起更新', async () => {
  const button = await setup()
  expect(button.getAttribute('aria-label')).toBe('生成')
  await act(async () => {
    button.setAttribute('title', '取消')
  })
  expect(screen.getByRole('tooltip').textContent).toBe('取消')
  expect(button.getAttribute('aria-label')).toBe('取消')
  fireEvent.pointerOut(button, { relatedTarget: document.body, pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(button.getAttribute('title')).toBe('取消')
  expect(button.hasAttribute('aria-label')).toBe(false)
  button.setAttribute('title', '再次生成')
  expect(screen.getByRole('button', { name: '再次生成' })).toBe(button)
})

it('显式无障碍名称不被悬停标题覆盖', async () => {
  const button = await setup('生成', true)
  await act(async () => {
    button.setAttribute('title', '取消')
  })
  expect(button.getAttribute('aria-label')).toBe('固定名称')
})

it.each(['empty', 'remove', 'replace'] as const)(
  '标题 %s 与指针离开同一任务发生时不恢复旧标题',
  async (change) => {
    const button = await setup()
    act(() => {
      if (change === 'remove') button.removeAttribute('title')
      else button.setAttribute('title', change === 'empty' ? '' : '新说明')
      fireEvent.pointerOut(button, { relatedTarget: document.body, pointerType: 'mouse' })
    })
    await act(() => vi.advanceTimersByTimeAsync(200))
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(button.getAttribute('title')).toBe(
      change === 'remove' ? null : change === 'empty' ? '' : '新说明',
    )
    expect(button.hasAttribute('data-tip')).toBe(false)
  },
)

it('来源控件被移除时立即清理提示', async () => {
  const button = await setup()
  const parent = button.parentElement!
  await act(async () => {
    button.remove()
  })
  expect(screen.queryByRole('tooltip')).toBeNull()
  parent.append(button)
})

it('图标被替换漏掉 pointerout，进入其他元素仍会清理提示', async () => {
  const button = await setup()
  act(() => {
    button.replaceChildren(document.createElement('span'))
    fireEvent.pointerOver(document.body, { pointerType: 'mouse' })
  })
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.queryByRole('tooltip')).toBeNull()
})

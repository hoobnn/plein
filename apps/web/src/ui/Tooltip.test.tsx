// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen, waitFor } from '../testing/render'
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
  await waitFor(() =>
    expect(document.querySelector('[data-base-ui-tooltip-trigger]')).not.toBeNull(),
  )
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

it('首个提示等待 450ms，相邻按钮立即接力且保留关闭间隙', async () => {
  vi.useFakeTimers()
  renderApp(
    <>
      <button type="button" title="第一提示" aria-label="第一按钮" />
      <button type="button" title="第二提示" aria-label="第二按钮" />
      <TooltipHost />
    </>,
  )
  const first = screen.getByRole('button', { name: '第一按钮' })
  const second = screen.getByRole('button', { name: '第二按钮' })
  fireEvent.pointerOver(first, { pointerType: 'mouse' })
  await waitFor(() =>
    expect(document.querySelector('[data-base-ui-tooltip-trigger]')).not.toBeNull(),
  )
  await act(() => vi.advanceTimersByTimeAsync(449))
  expect(screen.queryByRole('tooltip')).toBeNull()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.getByRole('tooltip').textContent).toBe('第一提示')

  fireEvent.pointerOut(first, { relatedTarget: second, pointerType: 'mouse' })
  fireEvent.pointerOver(second, { pointerType: 'mouse' })
  expect(screen.getByRole('tooltip').textContent).toBe('第二提示')
  fireEvent.pointerOut(second, { relatedTarget: document.body, pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(149))
  expect(screen.getByRole('tooltip').textContent).toBe('第二提示')
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('按钮与 SVG 子节点之间移动不关闭，离开后重新进入仍显示', async () => {
  const button = await setup()
  const svg = button.querySelector('svg')!
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  svg.append(path)

  fireEvent.pointerOver(svg, { pointerType: 'mouse' })
  expect(screen.getByRole('tooltip').textContent).toBe('生成')
  fireEvent.pointerOver(path, { pointerType: 'mouse' })
  expect(screen.getByRole('tooltip').textContent).toBe('生成')
  fireEvent.pointerOver(button, { pointerType: 'mouse' })
  expect(screen.getByRole('tooltip').textContent).toBe('生成')

  fireEvent.pointerOut(button, { relatedTarget: document.body, pointerType: 'mouse' })
  await act(() => vi.advanceTimersByTimeAsync(200))
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.pointerOver(button, { pointerType: 'mouse' })
  await waitFor(() =>
    expect(document.querySelector('[data-base-ui-tooltip-trigger]')).not.toBeNull(),
  )
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(screen.getByRole('tooltip').textContent).toBe('生成')
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

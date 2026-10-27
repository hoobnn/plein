// @vitest-environment happy-dom
import type { ArrangeResult, Engine } from '@plein/canvas-core'
import { expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { act, fireEvent, renderApp, screen } from '../testing/render'
import { ArrangeToast } from './ArrangeToast'

function setup() {
  const listeners = new Set<() => void>()
  const subscribe = (fn: () => void) => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }
  const engine = {
    onStateChange: subscribe,
    onMove: subscribe,
    selection: { onChange: subscribe },
    doc: { subscribe, readOnly: false },
    camera: { insets: { left: 0 }, onInsetsChange: subscribe },
  } as unknown as Engine
  const arranged = { stale: vi.fn(() => false), revert: vi.fn() } as unknown as ArrangeResult
  useCanvas.setState({ engine, arranged })
  const view = renderApp(<ArrangeToast />)
  const refresh = () =>
    act(() => {
      for (const listener of listeners) listener()
    })
  return { ...view, engine, arranged, refresh }
}

it('只读明确禁用还原，恢复可写后还原一次并关闭', async () => {
  const f = setup()
  f.engine.doc.readOnly = true
  f.refresh()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '还原' }).disabled).toBe(true)
  expect(screen.getByRole('status').textContent).toContain('当前只读，暂时无法还原')
  f.engine.doc.readOnly = false
  f.refresh()
  await f.user.click(screen.getByRole('button', { name: '还原' }))
  expect(f.arranged.revert).toHaveBeenCalledOnce()
  expect(useCanvas.getState().arranged).toBeNull()
})

it('后续编辑或撤销导致过期后清除提示，恢复旧栈顶也不复活', () => {
  const f = setup()
  vi.mocked(f.arranged.stale).mockReturnValue(true)
  f.refresh()
  expect(useCanvas.getState().arranged).toBeNull()
  vi.mocked(f.arranged.stale).mockReturnValue(false)
  f.refresh()
  expect(screen.queryByRole('button', { name: '还原' })).toBeNull()
  expect(f.arranged.revert).not.toHaveBeenCalled()
})

it('键盘保留关闭提示但不触发还原', async () => {
  const f = setup()
  act(() => screen.getByRole('button', { name: '保留' }).focus())
  await f.user.keyboard('{Enter}')
  expect(useCanvas.getState().arranged).toBeNull()
  expect(f.arranged.revert).not.toHaveBeenCalled()
})

it.each(['hover', 'focus', 'readonly'] as const)(
  '%s 时不丢失还原入口，离开后重新计时',
  async (mode) => {
    vi.useFakeTimers()
    const f = setup()
    const button = screen.getByRole('button', { name: '还原' })
    if (mode === 'hover') fireEvent.mouseEnter(button)
    else if (mode === 'focus') act(() => button.focus())
    else {
      f.engine.doc.readOnly = true
      f.refresh()
    }
    await act(() => vi.advanceTimersByTimeAsync(20_000))
    expect(useCanvas.getState().arranged).toBe(f.arranged)
    if (mode === 'hover') fireEvent.mouseLeave(button)
    else if (mode === 'focus') act(() => button.blur())
    else {
      f.engine.doc.readOnly = false
      f.refresh()
    }
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(useCanvas.getState().arranged).toBeNull()
    expect(f.arranged.revert).not.toHaveBeenCalled()
  },
)

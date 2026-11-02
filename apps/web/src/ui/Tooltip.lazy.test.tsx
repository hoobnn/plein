// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen, waitFor } from '../testing/render'
import { TooltipHost } from './Tooltip'

const evaluation = vi.hoisted(() => ({ count: 0 }))
vi.mock('./TooltipBubble', () => {
  evaluation.count++
  return {
    TooltipBubble: ({ current }: { current: { text: string } | null }) => (
      <div data-testid="lazy-tooltip-target">{current?.text}</div>
    ),
  }
})

it('首次有效悬停前不下载气泡模块，加载后接管当前目标', async () => {
  renderApp(
    <>
      <button type="button" title="生成" aria-label="生成按钮" />
      <TooltipHost />
    </>,
  )
  await act(async () => {})
  expect(evaluation.count).toBe(0)

  fireEvent.pointerOver(screen.getByRole('button', { name: '生成按钮' }), {
    pointerType: 'mouse',
  })
  await waitFor(() => expect(evaluation.count).toBe(1))
  expect((await screen.findByTestId('lazy-tooltip-target')).textContent).toBe('生成')
})

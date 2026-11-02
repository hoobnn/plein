// @vitest-environment happy-dom
import { useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { act, renderApp, screen } from '../testing/render'
import { Slider } from './Slider'

function ControlledSlider({
  disabled = false,
  onCommit,
}: {
  disabled?: boolean
  onCommit?: () => void
}) {
  const [value, setValue] = useState(5)
  return (
    <Slider
      aria-label="音量"
      value={value}
      min={0}
      max={10}
      step={1}
      disabled={disabled}
      onValueChange={setValue}
      onValueCommitted={onCommit}
    />
  )
}

it('方向键、Home 和 End 按步长修改值，并分别提交每次键盘交互', async () => {
  const onCommit = vi.fn()
  const view = renderApp(<ControlledSlider onCommit={onCommit} />)
  const slider = screen.getByRole('slider', { name: '音量' })

  expect(slider).toHaveProperty('min', '0')
  expect(slider).toHaveProperty('max', '10')
  expect(slider.getAttribute('aria-valuenow')).toBe('5')
  expect(slider.getAttribute('aria-orientation')).toBe('horizontal')

  act(() => slider.focus())
  await view.user.keyboard('{ArrowRight}')
  expect(slider.getAttribute('aria-valuenow')).toBe('6')
  await view.user.keyboard('{ArrowLeft}')
  expect(slider.getAttribute('aria-valuenow')).toBe('5')
  await view.user.keyboard('{Home}')
  expect(slider.getAttribute('aria-valuenow')).toBe('0')
  await view.user.keyboard('{End}')
  expect(slider.getAttribute('aria-valuenow')).toBe('10')
  expect(onCommit).toHaveBeenCalledTimes(4)
})

it('禁用滑块不响应键盘修改', async () => {
  const onCommit = vi.fn()
  const view = renderApp(<ControlledSlider disabled onCommit={onCommit} />)
  const slider = screen.getByRole('slider', { name: '音量' })

  expect(slider).toHaveProperty('disabled', true)
  act(() => slider.focus())
  await view.user.keyboard('{ArrowRight}{Home}{End}')
  expect(slider.getAttribute('aria-valuenow')).toBe('5')
  expect(onCommit).not.toHaveBeenCalled()
})

// @vitest-environment happy-dom
import { useState } from 'react'
import { expect, it } from 'vite-plus/test'
import { fireEvent, renderApp, screen } from '../../testing/render'
import { PoseControl } from './PoseControl'

function Control({ min = 25, max = 100, initial = 55 }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <PoseControl
        label="视角"
        value={value}
        min={min}
        max={max}
        disabled={false}
        onChange={setValue}
      />
      <output>{value}</output>
    </>
  )
}

it('清空后逐字输入新的视角不会被最小值抢写，失焦恢复空草稿', async () => {
  const { user } = renderApp(<Control />)
  const input = screen.getByRole('spinbutton') as HTMLInputElement
  await user.clear(input)
  expect(input.value).toBe('')
  await user.type(input, '90')
  expect(input.value).toBe('90')
  expect(screen.getByRole('status').textContent).toBe('90')
  await user.clear(input)
  fireEvent.blur(input)
  expect(input.value).toBe('90')
})

it('负数可输入，越界草稿到确认时才约束；滑块改动同步数字控件', async () => {
  const { user } = renderApp(<Control min={-180} max={180} initial={0} />)
  const input = screen.getByRole('spinbutton') as HTMLInputElement
  await user.clear(input)
  await user.type(input, '-30')
  expect(input.value).toBe('-30')
  await user.clear(input)
  await user.type(input, '999')
  expect(input.value).toBe('999')
  await user.keyboard('{Enter}')
  expect(input.value).toBe('180')
  fireEvent.change(screen.getByRole('slider'), { target: { value: '-90' } })
  expect(input.value).toBe('-90')
})

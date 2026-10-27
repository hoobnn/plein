// @vitest-environment happy-dom
import { useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { renderApp, screen } from '../../testing/render'
import { ParamsPill } from './ParamsPill'

it('历史字符串布尔值原样展示，显式选择写入布尔，默认与恢复不会混为 false', async () => {
  const changes = vi.fn()
  function Host() {
    const [value, setValue] = useState<Record<string, unknown>>({ watermark: 'false' })
    return (
      <ParamsPill
        fields={[]}
        rest={{}}
        params={{}}
        onChange={() => {}}
        options={{
          title: '图片参数',
          schema: { properties: { watermark: { type: 'boolean', title: '水印' } } },
          value,
          onChange: (next) => {
            changes(next)
            setValue(next)
          },
        }}
      />
    )
  }
  const { user } = renderApp(<Host />)
  await user.click(screen.getByRole('button', { name: '参数' }))
  await user.click(screen.getByRole('button', { name: '更多参数' }))
  const watermark = screen.getByRole('combobox', { name: '水印' })
  expect(watermark.textContent).toBe('false')
  await user.click(watermark)
  await user.click(screen.getByRole('option', { name: '关' }))
  expect(changes).toHaveBeenLastCalledWith({ watermark: false })
  await user.click(watermark)
  await user.click(screen.getByRole('option', { name: '默认' }))
  expect(changes).toHaveBeenLastCalledWith({})
  await user.click(watermark)
  await user.click(screen.getByRole('option', { name: '开' }))
  await user.click(screen.getByRole('button', { name: '恢复模型默认参数' }))
  expect(changes).toHaveBeenLastCalledWith({})
})

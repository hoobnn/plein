// @vitest-environment happy-dom
import { useEffect, useState } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { act, fireEvent, renderApp, screen } from '../testing/render'
import { SchemaForm } from './SchemaForm'

it.each(['使用最新数值', '保留当前数值'])(
  '同帧数值更新保留草稿，%s后恢复焦点并继续编辑',
  async (choice) => {
    let current: Record<string, unknown> = { temperature: 1.1, keep: 'original' }
    const write = vi.fn((value: Record<string, unknown>) => {
      current = value
    })
    let refresh!: () => void
    function Form() {
      const [, setRevision] = useState(0)
      useEffect(() => {
        refresh = () => setRevision((value) => value + 1)
      }, [])
      return (
        <SchemaForm
          schema={{
            properties: { temperature: { title: '温度', type: 'number', minimum: 0, maximum: 2 } },
          }}
          value={current}
          readValue={() => current}
          onChange={(value) => {
            write(value)
            refresh()
          }}
        />
      )
    }
    const f = renderApp(<Form />)
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: '温度' })
    act(() => {
      current = { temperature: 0.8, keep: 'peer' }
      refresh()
    })
    expect(input.value).toBe('0.8')
    await f.user.click(input)
    fireEvent.change(input, { target: { value: '1.6' } })
    act(() => {
      current = { temperature: 0.4, keep: 'peer' }
      input.blur()
      refresh()
    })
    expect(write).not.toHaveBeenCalled()
    expect(input.value).toBe('1.6')
    expect(screen.getByRole('status').textContent).toContain('0.4')
    await f.user.click(screen.getByRole('button', { name: choice }))
    expect(input.value).toBe(choice === '使用最新数值' ? '0.4' : '1.6')
    expect(document.activeElement).toBe(input)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.change(input, { target: { value: '1.2' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(current).toEqual({ temperature: 1.2, keep: 'peer' })
  },
)

// @vitest-environment happy-dom
import { useState } from 'react'
import { describe, expect, it } from 'vite-plus/test'
import { fireEvent, renderApp, screen, waitFor } from '../../testing/render'
import { NameField } from './NameField'

/** 模拟画布：同伴在别处改名时 value 会变；只读时 onChange 返回 false */
function Harness({
  initial = '组字角色',
  readonly = false,
  onSave,
}: {
  initial?: string
  readonly?: boolean
  onSave?(name: string): void
}) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <NameField
        value={value}
        onChange={(v) => {
          if (readonly) return false
          setValue(v)
          onSave?.(v)
        }}
      />
      <button type="button" onClick={() => setValue('同伴改的名字')}>
        同伴改名
      </button>
      <span data-testid="current">{value}</span>
    </>
  )
}

const nameInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: '节点名称' })
const current = () => screen.getByTestId('current').textContent

describe('节点名称的编辑', () => {
  it('失焦保存去掉首尾空格的名字', () => {
    const saved: string[] = []
    renderApp(<Harness onSave={(v) => saved.push(v)} />)
    const input = nameInput()
    fireEvent.change(input, { target: { value: '  角色新名  ' } })
    fireEvent.blur(input)
    expect(saved).toEqual(['角色新名'])
    expect(current()).toBe('角色新名')
  })

  it('空白输入不保存，保留原名', () => {
    const saved: string[] = []
    renderApp(<Harness onSave={(v) => saved.push(v)} />)
    const input = nameInput()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(saved).toEqual([])
    expect(current()).toBe('组字角色')
    expect(input.value).toBe('组字角色')
  })

  it('回车提交，失焦不会重复提交', () => {
    const saved: string[] = []
    renderApp(<Harness onSave={(v) => saved.push(v)} />)
    const input = nameInput()
    input.focus()
    fireEvent.change(input, { target: { value: '角色新名' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(saved).toEqual(['角色新名'])
  })

  it('组字中的回车与 Esc 不提交草稿', () => {
    const saved: string[] = []
    renderApp(<Harness onSave={(v) => saved.push(v)} />)
    const input = nameInput()
    fireEvent.change(input, { target: { value: '角色新名' } })
    // 组字中：isComposing
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    // 组字中：keyCode 229
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(saved).toEqual([])
    expect(input.value).toBe('角色新名')
  })

  it('Esc 取消草稿，保留已保存的名字', () => {
    renderApp(<Harness />)
    const input = nameInput()
    fireEvent.change(input, { target: { value: '角色新名' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('组字角色')
    expect(current()).toBe('组字角色')
  })

  it('画布变只读时提交被拒绝，不抛错并保留原名', () => {
    renderApp(<Harness readonly />)
    const input = nameInput()
    input.focus()
    fireEvent.change(input, { target: { value: '角色新名' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(current()).toBe('组字角色')
    expect(input.value).toBe('组字角色')
  })

  it('同伴改名时不覆盖未提交的草稿，明确让用户选一个', async () => {
    renderApp(<Harness />)
    const input = nameInput()
    fireEvent.change(input, { target: { value: '我的草稿' } })

    screen.getByRole('button', { name: '同伴改名' }).click()
    await waitFor(() => expect(current()).toBe('同伴改的名字'))

    // 草稿还在，并说明冲突
    expect(input.value).toBe('我的草稿')
    expect(screen.getByRole('status').textContent).toContain(
      '名称已在其他位置更新为「同伴改的名字」',
    )

    // 选「使用更新后的名称」：采用同伴的值
    screen.getByRole('button', { name: '使用更新后的名称' }).click()
    await waitFor(() => expect(input.value).toBe('同伴改的名字'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('选「保留当前输入」时提交本机草稿', async () => {
    const saved: string[] = []
    renderApp(<Harness onSave={(v) => saved.push(v)} />)
    const input = nameInput()
    fireEvent.change(input, { target: { value: '我的草稿' } })
    screen.getByRole('button', { name: '同伴改名' }).click()
    await waitFor(() => expect(current()).toBe('同伴改的名字'))

    screen.getByRole('button', { name: '保留当前输入' }).click()
    await waitFor(() => expect(saved).toEqual(['我的草稿']))
    expect(current()).toBe('我的草稿')
  })

  it('没有草稿时同伴改名直接跟随', async () => {
    renderApp(<Harness />)
    screen.getByRole('button', { name: '同伴改名' }).click()
    await waitFor(() => expect(nameInput().value).toBe('同伴改的名字'))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

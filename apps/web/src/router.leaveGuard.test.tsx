// @vitest-environment happy-dom
import { useEffect, useRef } from 'react'
import { afterEach, expect, it } from 'vite-plus/test'
import { navigate, registerLeaveGuard, setLeaveGuard, useRoute } from './router'
import { act, renderApp, screen, waitFor } from './testing/render'
import { confirmDialog } from './ui/Dialog'
import { useLeaveGuard } from './shell/useLeaveGuard'

afterEach(() => setLeaveGuard(null))

let visited: string[] = []

function Harness() {
  const route = useRoute()
  const name = route.name === 'canvas' ? `canvas:${route.id}` : route.name
  const last = useRef('')
  useEffect(() => {
    if (last.current !== name) {
      last.current = name
      visited.push(name)
    }
  }, [name])
  return <span data-testid="route">{name}</span>
}

const dirtyGuard = () =>
  setLeaveGuard({
    blocks: () => true,
    confirm: () =>
      confirmDialog({
        title: '还有改动没有保存',
        confirmLabel: '丢弃改动并离开',
        cancelLabel: '留在编辑',
        danger: true,
      }),
  })

it('选择留在编辑时留在原画布，明确丢弃后只导航一次', async () => {
  visited = []
  const { user } = renderApp(<Harness />, { route: { name: 'canvas', id: 'a' } })
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('canvas:a'))
  expect(location.hash).toBe('#/c/a')
  dirtyGuard()

  await act(async () => navigate({ name: 'home' }))
  await user.click(await screen.findByRole('button', { name: '留在编辑' }))
  expect(screen.getByTestId('route').textContent).toBe('canvas:a')
  expect(location.hash).toBe('#/c/a')
  expect(visited).toEqual(['canvas:a'])

  await act(async () => navigate({ name: 'home' }))
  await user.click(await screen.findByRole('button', { name: '丢弃改动并离开' }))
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('home'))
  expect(location.hash).toBe('#/')
  expect(visited).toEqual(['canvas:a', 'home'])
})

it('没有未保存改动时直接离开，不弹确认', async () => {
  visited = []
  renderApp(<Harness />, { route: { name: 'canvas', id: 'a' } })
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('canvas:a'))
  setLeaveGuard({ blocks: () => false, confirm: async () => false })
  await act(async () => navigate({ name: 'home' }))
  expect(screen.getByTestId('route').textContent).toBe('home')
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('浏览器后退先恢复地址再询问，取消后仍在原画布', async () => {
  visited = []
  const { user } = renderApp(<Harness />, { route: { name: 'canvas', id: 'a' } })
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('canvas:a'))
  dirtyGuard()

  // 浏览器后退已经把地址改成首页：路由恢复地址并询问
  await act(async () => {
    location.hash = '#/'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  await user.click(await screen.findByRole('button', { name: '留在编辑' }))
  expect(location.hash).toBe('#/c/a')
  expect(screen.getByTestId('route').textContent).toBe('canvas:a')

  // 再来一次，这次明确放弃
  await act(async () => {
    location.hash = '#/'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  await user.click(await screen.findByRole('button', { name: '丢弃改动并离开' }))
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('home'))
  expect(location.hash).toBe('#/')
  expect(visited).toEqual(['canvas:a', 'home'])
})

it('刷新与关闭页面时给出浏览器提示，没有未保存改动时不拦', async () => {
  function Guarded({ active }: { active: boolean }) {
    useLeaveGuard(active, '第一张画布')
    return null
  }
  const view = renderApp(<Guarded active />)
  const blocked = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(blocked)
  expect(blocked.defaultPrevented).toBe(true)

  view.rerender(<Guarded active={false} />)
  const allowed = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(allowed)
  expect(allowed.defaultPrevented).toBe(false)
})

it('附加 guard 与文档 guard 共存，注销后文档 guard 仍单独生效', async () => {
  visited = []
  const { user } = renderApp(<Harness />, { route: { name: 'canvas', id: 'a' } })
  await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('canvas:a'))
  dirtyGuard()
  const unregister = registerLeaveGuard({
    blocks: () => true,
    confirm: () =>
      confirmDialog({
        title: '镜头草稿还没有保存',
        confirmLabel: '丢弃草稿并离开',
        cancelLabel: '留在工作台',
        danger: true,
      }),
  })
  try {
    await act(async () => navigate({ name: 'home' }))
    await user.click(await screen.findByRole('button', { name: '丢弃改动并离开' }))
    await user.click(await screen.findByRole('button', { name: '留在工作台' }))
    expect(screen.getByTestId('route').textContent).toBe('canvas:a')
    expect(location.hash).toBe('#/c/a')

    unregister()
    await act(async () => navigate({ name: 'home' }))
    await user.click(await screen.findByRole('button', { name: '丢弃改动并离开' }))
    await waitFor(() => expect(screen.getByTestId('route').textContent).toBe('home'))
    expect(location.hash).toBe('#/')
  } finally {
    unregister()
  }
})

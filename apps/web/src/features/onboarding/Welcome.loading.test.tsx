// @vitest-environment happy-dom
import type { Catalog } from '@plein/protocol'
import { expect, it, vi } from 'vite-plus/test'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { Welcome } from './Welcome'

const loading = vi.hoisted(() => {
  let resolve!: () => void
  let loaded!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  const settled = new Promise<void>((done) => {
    loaded = done
  })
  return { promise, resolve, loaded, settled, calls: 0 }
})
vi.mock('./WelcomeDialog', async (original) => {
  loading.calls++
  await loading.promise
  const module = await original()
  loading.loaded()
  return module
})
resetStoreAfterEach(useCatalog)

it('已完成引导时不加载模块，也不显示骨架', async () => {
  localStorage.setItem('plein.welcome', '1')
  const fetch = mockFetch()
  renderApp(<Welcome />, { dialogs: false })
  await act(async () => {})
  expect(loading.calls).toBe(0)
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.queryByRole('status')).toBeNull()
})

it('首次引导模块等待有状态反馈，加载完成后显示真实配置面板', async () => {
  const catalog: Catalog = {
    plugins: [],
    nodes: [],
    templates: [],
    prompts: [],
    elements: [],
    defaultModels: {},
    providers: [],
  }
  mockFetch((request) =>
    new URL(request.url).pathname === '/api/catalog' ? Response.json(catalog) : undefined,
  )
  const { user } = renderApp(<Welcome />, { dialogs: false })
  await waitFor(() => expect(loading.calls).toBe(1))
  expect(screen.getByRole('status').textContent).toBe('正在打开首次使用引导…')
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => {
    loading.resolve()
    await loading.settled
  })
  await screen.findByRole('dialog', { name: '欢迎使用 Plein' })
  expect(screen.queryByRole('status')).toBeNull()
  await user.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('status')).toBeNull()
})

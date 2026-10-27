// @vitest-environment happy-dom
import type { Catalog } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { Welcome } from './Welcome'

resetStoreAfterEach(useCatalog)

const catalog = (configured = false): Catalog => ({
  plugins: [],
  nodes: [],
  templates: [],
  prompts: [],
  elements: [],
  defaultModels: {},
  providers: configured
    ? [
        {
          id: 'test/platform',
          plugin: 'test/plugin',
          title: '测试平台',
          enabled: true,
          configured: true,
          settingsSchema: {},
          secrets: [],
          models: [],
        },
      ]
    : [],
})

it('已完成引导时不读取平台目录，也不重试其他页面留下的目录错误', async () => {
  localStorage.setItem('plein.welcome', '1')
  useCatalog.setState({ error: '上一次读取失败' })
  const fetch = mockFetch()
  renderApp(<Welcome />)
  await act(async () => {})
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('首次使用先读取目录，已有可用平台时不打开引导', async () => {
  const fetch = mockFetch((request) =>
    new URL(request.url).pathname === '/api/catalog' ? Response.json(catalog(true)) : undefined,
  )
  renderApp(<Welcome />)
  await waitFor(() => expect(useCatalog.getState().catalog).not.toBeNull())
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('需要引导时加载配置面板，关闭后目录变化和重新挂载都不会再次打开', async () => {
  const fetch = mockFetch((request) =>
    new URL(request.url).pathname === '/api/catalog' ? Response.json(catalog()) : undefined,
  )
  const view = renderApp(<Welcome />)
  await screen.findByRole('dialog', { name: '欢迎使用 Plein' })
  await view.user.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(localStorage.getItem('plein.welcome')).toBe('1')
  act(() => useCatalog.setState({ catalog: catalog() }))
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()
  renderApp(<Welcome />)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('dialog')).toBeNull()
})

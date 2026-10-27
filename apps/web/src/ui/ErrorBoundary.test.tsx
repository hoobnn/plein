// @vitest-environment happy-dom
import { lazy, Suspense } from 'react'
import { expect, it, vi } from 'vite-plus/test'
import { renderApp, screen } from '../testing/render'
import { ErrorBoundary } from './ErrorBoundary'

it('路由 chunk 拒绝后保留错误提示与刷新入口，不重试已缓存的失败模块', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const load = vi.fn(() => Promise.reject(new Error('Failed to fetch dynamically imported module')))
  const Page = lazy(load)
  const reload = vi.fn()
  const { user } = renderApp(
    <ErrorBoundary reload={reload}>
      <Suspense fallback={<p>正在打开…</p>}>
        <Page />
      </Suspense>
    </ErrorBoundary>,
    { dialogs: false },
  )
  expect((await screen.findByRole('alert')).textContent).toContain('页面加载失败')
  expect(screen.getByText('请刷新页面后重新打开。')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: '刷新页面' }))
  expect(reload).toHaveBeenCalledTimes(1)
  expect(load).toHaveBeenCalledTimes(1)
})

it('普通渲染异常同样保留恢复入口', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  function Broken(): never {
    throw new Error('页面内容损坏')
  }
  renderApp(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
    { dialogs: false },
  )
  expect(screen.getByRole('alert').textContent).toContain('页面内容损坏')
  expect(screen.getByRole('button', { name: '刷新页面' })).toBeTruthy()
})

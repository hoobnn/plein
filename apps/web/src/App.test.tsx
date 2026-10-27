// @vitest-environment happy-dom
import { expect, it, vi } from 'vite-plus/test'
import { mockFetch } from './testing/fetch'
import { act, renderApp, screen, waitFor } from './testing/render'
import { App } from './App'

// 会话门控在画布路由上的行为只需要 DOM：画布引擎边界用可观测替身，不加载 Pixi
vi.mock('./canvas/CanvasView', () => ({
  CanvasView: () => <div data-testid="canvas-view-stub" />,
}))

const session = {
  principal: { id: 'local', role: 'owner' as const },
  authRequired: false,
  needsSetup: false,
}

/** 会话读取之外的页面读取：空目录、项目列表与画布页头 */
const homeReads = (request: Request) => {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/catalog')
    return Response.json({ providers: [] })
  if (request.method === 'GET' && url.pathname === '/api/projects') return Response.json([])
  if (request.method === 'GET' && url.pathname === '/api/canvases/canvas-1')
    return Response.json({
      id: 'canvas-1',
      projectId: 'p-1',
      title: '正在编辑的画布',
      createdAt: 1,
      updatedAt: 1,
    })
  if (request.method === 'GET' && url.pathname === '/api/projects/p-1')
    return Response.json({
      id: 'p-1',
      title: '画布所在项目',
      canvases: 1,
      lastCanvasId: 'canvas-1',
      createdAt: 1,
      updatedAt: 1,
    })
  if (request.method === 'GET' && url.pathname === '/api/projects/p-1/canvases')
    return Response.json([
      { id: 'canvas-1', projectId: 'p-1', title: '正在编辑的画布', createdAt: 1, updatedAt: 1 },
    ])
  if (request.method === 'GET' && url.pathname === '/api/canvases/canvas-1/agent/sessions')
    return Response.json([])
  if (request.method === 'GET' && url.pathname === '/api/templates') return Response.json([])
  if (request.method === 'GET' && url.pathname === '/api/library') return Response.json([])
}

it('首次连接等待显示状态，恢复后显示项目列表', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/session') return held
    return homeReads(request)
  })
  renderApp(<App />)
  expect(screen.getByRole('status').textContent).toContain('正在连接 Plein')
  await act(async () => release(Response.json(session)))
  await waitFor(() => expect(screen.getByRole('heading', { name: /我的项目/ })).toBeTruthy())
})

it('连接失败保留具体原因，重试有防重，恢复后仍留在原画布', async () => {
  // 从原画布路由开始：会话恢复后必须仍在这张画布上
  history.replaceState(null, '', '#/c/canvas-1')
  let mode: 'fail' | 'retry-fail' | 'success' = 'fail'
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let retries = 0
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/session') {
      if (mode === 'fail') return Response.json({ message: '连接暂不可用' }, { status: 503 })
      retries++
      if (mode === 'retry-fail')
        return held.then(() => Response.json({ message: '服务仍在恢复' }, { status: 503 }))
      return Response.json(session)
    }
    return homeReads(request)
  })
  renderApp(<App />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('无法连接 Plein：连接暂不可用')
  // 错误文案不出现开发提示
  expect(document.body.textContent).not.toContain('pnpm dev:server')
  mode = 'retry-fail'
  const retry = screen.getByRole('button', { name: '重试' })
  act(() => {
    retry.click()
    retry.click()
  })
  await waitFor(() => expect(retries).toBe(1))
  expect((retry as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('button', { name: '正在重试…' }).textContent).toContain('正在重试')
  await act(async () => release())
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('服务仍在恢复'))
  mode = 'success'
  screen.getByRole('button', { name: '重试' }).click()
  // 恢复后仍在原画布：页头是这张画布（Editor 懒加载较重，放宽等待）
  await waitFor(() => expect(screen.getByRole('button', { name: '切换画布' })).toBeTruthy(), {
    timeout: 10_000,
  })
  expect(location.hash).toBe('#/c/canvas-1')
  await waitFor(() => expect(screen.getByTestId('canvas-view-stub')).toBeTruthy(), {
    timeout: 5_000,
  })
  expect(retries).toBe(2)
})

it('会话接口自身 401 时停止自动读取，手动重试可恢复', async () => {
  let reads = 0
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/session') {
      reads++
      return reads === 1
        ? Response.json({ message: '会话服务拒绝读取' }, { status: 401 })
        : Response.json(session)
    }
    return homeReads(request)
  })
  renderApp(<App />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('会话服务拒绝读取')
  expect(reads).toBe(1)
  screen.getByRole('button', { name: '重试' }).click()
  await waitFor(() => expect(screen.getByRole('heading', { name: /我的项目/ })).toBeTruthy())
  expect(reads).toBe(2)
})

it('无效链接显示恢复入口，回到项目列表后可继续使用', async () => {
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/session') return Response.json(session)
    return homeReads(request)
  })
  // 无效编码的画布地址：不完整的百分号转义
  history.replaceState(null, '', '#/c/%E0%A4%A')
  renderApp(<App />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('链接格式不正确')
  screen.getByRole('link', { name: '回到项目列表' }).click()
  await waitFor(() => expect(screen.getByRole('heading', { name: /我的项目/ })).toBeTruthy())
})

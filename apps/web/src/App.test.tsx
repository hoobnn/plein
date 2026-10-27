// @vitest-environment happy-dom
import { expect, it } from 'vite-plus/test'
import { mockFetch } from './testing/fetch'
import { act, renderApp, screen, waitFor } from './testing/render'
import { App } from './App'

const session = {
  principal: { id: 'local', role: 'owner' as const },
  authRequired: false,
  needsSetup: false,
}

/** 会话读取之外的首页读取：空目录与项目列表 */
const homeReads = (request: Request) => {
  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/api/catalog')
    return Response.json({ providers: [] })
  if (request.method === 'GET' && url.pathname === '/api/projects') return Response.json([])
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

it('连接失败保留具体原因，重试有防重，恢复后仍进入原画布', async () => {
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
  await waitFor(() => expect(screen.getByRole('heading', { name: /我的项目/ })).toBeTruthy())
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

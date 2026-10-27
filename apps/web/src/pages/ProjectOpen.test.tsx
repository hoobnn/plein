// @vitest-environment happy-dom
import type { Project } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { mockFetch } from '../testing/fetch'
import { act, renderApp, screen, waitFor } from '../testing/render'
import { ProjectOpen } from './ProjectOpen'

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p-1',
  title: '空项目',
  createdAt: 1,
  updatedAt: 1,
  canvases: 0,
  lastCanvasId: null,
  ...over,
})

const canvas = { id: 'canvas-1', projectId: 'p-1', title: '画布 1', createdAt: 1, updatedAt: 1 }

it('打开空项目期间显示加载状态，只创建一张画布', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/projects/p-1') return held
    if (request.method === 'POST' && url.pathname === '/api/canvases') return Response.json(canvas)
  })
  renderApp(<ProjectOpen id="p-1" />)
  expect(screen.getByRole('status').textContent).toContain('正在打开项目')
  release(Response.json(project()))
  await waitFor(() => expect(location.hash).toBe('#/c/canvas-1'))
  // 打开用 replace：返回键不应落回跳转页
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it('项目读取失败可原地重试，等待期间不重复读取', async () => {
  let fail = true
  let reads = 0
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/projects/p-1') {
      reads++
      if (fail) return Response.json({ message: '项目读取暂不可用' }, { status: 503 })
      return Response.json(project({ lastCanvasId: 'canvas-1' }))
    }
  })
  renderApp(<ProjectOpen id="p-1" />)
  expect((await screen.findByRole('alert')).textContent).toContain(
    '打不开这个项目：项目读取暂不可用',
  )
  fail = false
  const retry = screen.getByRole('button', { name: '重新打开' })
  retry.click()
  retry.click()
  await waitFor(() => expect(location.hash).toBe('#/c/canvas-1'))
  expect(reads).toBe(2)
  expect(screen.queryByRole('alert')).toBeNull()
})

it('已删除项目链接说明原因，不提供重新打开，可回到项目列表', async () => {
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/projects/gone')
      return Response.json({ message: '项目不存在' }, { status: 404 })
  })
  renderApp(<ProjectOpen id="gone" />)
  expect((await screen.findByRole('alert')).textContent).toContain('打不开这个项目：项目不存在')
  // 404 重试也没有意义，不能给无效入口
  expect(screen.queryByRole('button', { name: '重新打开' })).toBeNull()
  screen.getByRole('link', { name: '回到项目列表' }).click()
  expect(location.hash).toBe('#/')
})

it('首画布创建确认丢失后重新打开，用服务端已建的画布，不重复创建', async () => {
  let writes = 0
  let committed = false
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/projects/p-1')
      // 第一次创建虽未确认，但服务端已建好画布：重新打开时直接用它
      return Response.json(project({ lastCanvasId: committed ? 'canvas-1' : null }))
    if (request.method === 'POST' && url.pathname === '/api/canvases') {
      writes++
      return held
    }
  })
  renderApp(<ProjectOpen id="p-1" />)
  await waitFor(() => expect(writes).toBe(1))
  // 创建确认丢失
  committed = true
  await act(async () => release(Response.json({ message: '未收到画布创建确认' }, { status: 503 })))
  expect((await screen.findByRole('alert')).textContent).toContain('未收到画布创建确认')
  screen.getByRole('button', { name: '重新打开' }).click()
  await waitFor(() => expect(location.hash).toBe('#/c/canvas-1'))
  expect(writes).toBe(1)
})

it('读取途中离开首页，迟到应答不再创建画布或导航', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/projects/p-1') return held
  })
  const rendered = renderApp(<ProjectOpen id="p-1" />)
  await waitFor(() => expect(fetch.mock.calls).toHaveLength(1))
  rendered.unmount()
  await act(async () => release(Response.json(project())))
  await act(async () => {})
  expect(location.hash).toBe('#/')
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
})

it('创建等待期间离开再回来，复用同一次创建', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  let writes = 0
  mockFetch((request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/projects/p-1')
      return Response.json(project())
    if (request.method === 'POST' && url.pathname === '/api/canvases') {
      writes++
      return held
    }
  })
  const first = renderApp(<ProjectOpen id="p-1" />)
  await waitFor(() => expect(writes).toBe(1))
  first.unmount()
  renderApp(<ProjectOpen id="p-1" />)
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('正在打开项目'))
  expect(writes).toBe(1)
  await act(async () => release(Response.json(canvas)))
  await waitFor(() => expect(location.hash).toBe('#/c/canvas-1'))
  expect(writes).toBe(1)
})

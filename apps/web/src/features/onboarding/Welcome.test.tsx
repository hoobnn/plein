// @vitest-environment happy-dom
import type { Catalog, Project } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { takeStartNode, DRAMA_START } from '../../canvas/startQueue'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import {
  act,
  fireEvent,
  renderApp,
  resetStoreAfterEach,
  screen,
  waitFor,
} from '../../testing/render'
import { Welcome } from './Welcome'
resetStoreAfterEach(useCatalog)
const catalog = { providers: [], nodes: [], plugins: [], prompts: [] } as unknown as Catalog
const project: Project = {
  id: 'created-project',
  title: '新项目',
  createdAt: 1,
  updatedAt: 1,
  canvases: 1,
  lastCanvasId: 'created-canvas',
}
function setup() {
  let finish!: (response: Response) => void
  let writes = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/catalog') return Response.json(catalog)
    if (path === '/api/projects' && request.method === 'POST') {
      writes++
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    }
    if (path === '/api/projects') return Response.json([project])
  })
  useCatalog.setState({ catalog })
  const rendered = renderApp(<Welcome />)
  return {
    ...rendered,
    writes: () => writes,
    finish: (response = Response.json(project)) =>
      act(async () => {
        finish(response)
        await Promise.resolve()
      }),
  }
}
it('首次无平台显示引导，跳过后创建短剧登记意图，完成后不再显示', async () => {
  const f = setup()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '下一步' }).disabled).toBe(true)
  await f.user.click(screen.getByRole('button', { name: '跳过' }))
  await f.user.click(screen.getByRole('button', { name: /从短剧模板开始/ }))
  await f.finish()
  await waitFor(() => expect(location.hash).toBe('#/c/created-canvas'))
  expect(takeStartNode(project.lastCanvasId!)).toBe(DRAMA_START)
  expect(localStorage.getItem('plein.welcome')).toBe('1')
  f.unmount()
  renderApp(<Welcome />)
  expect(screen.queryByRole('dialog', { name: '欢迎使用 Plein' })).toBeNull()
})
it('等待说明、同帧双击仅一次提交，失败保留步骤并能重试', async () => {
  const f = setup()
  await f.user.click(screen.getByRole('button', { name: '跳过' }))
  const start = screen.getByRole('button', { name: /空白画布/ })
  act(() => {
    fireEvent.click(start)
    fireEvent.click(start)
  })
  await waitFor(() => expect(f.writes()).toBe(1))
  expect(screen.getByRole('status').textContent).toContain('正在创建项目')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '上一步' }).disabled).toBe(true)
  await f.finish(Response.json({ message: '创建连接中断' }, { status: 503 }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('创建连接中断'))
  await f.user.click(start)
  await f.finish()
  await waitFor(() => expect(location.hash).toBe('#/c/created-canvas'))
  expect(f.writes()).toBe(2)
})
it.each(['关闭', 'Escape'] as const)(
  '创建期间 %s，迟到完成只提示项目并保留短剧意图，不接管新导航',
  async (exit) => {
    const f = setup()
    await f.user.click(screen.getByRole('button', { name: '跳过' }))
    await f.user.click(screen.getByRole('button', { name: /从短剧模板开始/ }))
    if (exit === '关闭') await f.user.click(screen.getByRole('button', { name: '关闭' }))
    else await f.user.keyboard('{Escape}')
    act(() => {
      location.hash = '#/c/other-canvas'
    })
    await f.finish()
    await waitFor(() => expect(useCanvas.getState().notice).toContain('已创建项目'))
    expect(location.hash).toBe('#/c/other-canvas')
    expect(takeStartNode(project.lastCanvasId!)).toBe(DRAMA_START)
  },
)
it('旧引导卸载重开后迟到失败不关闭新引导，保留可操作的新步骤', async () => {
  const f = setup()
  await f.user.click(screen.getByRole('button', { name: '跳过' }))
  await f.user.click(screen.getByRole('button', { name: /空白画布/ }))
  f.unmount()
  renderApp(<Welcome />)
  await f.finish(Response.json({ message: '旧连接中断' }, { status: 503 }))
  await waitFor(() => expect(useCanvas.getState().notice).toContain('创建项目未获确认：旧连接中断'))
  expect(screen.getByRole('dialog', { name: '欢迎使用 Plein' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '跳过' })).toBeTruthy()
  expect(location.hash).toBe('#/')
})

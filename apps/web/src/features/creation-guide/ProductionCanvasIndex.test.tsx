// @vitest-environment happy-dom
import { expect, it } from 'vite-plus/test'
import { queryKeys } from '../../api/query'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { ProductionCanvasIndex } from './ProductionCanvasIndex'

it('折叠时零请求，展开只读本项目索引，空态说明并能导航现有画布', async () => {
  const paths: string[] = []
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    paths.push(path)
    if (path === '/api/canvases/c') return Response.json({ id: 'c', projectId: 'p' })
    if (path === '/api/projects/p/canvases')
      return Response.json([
        { id: 'c', title: '当前画布' },
        { id: 'other', title: '其他画布' },
      ])
  })
  const f = renderApp(<ProductionCanvasIndex canvasId="c" />)
  expect(paths).toEqual([])
  await f.user.click(screen.getByText('当前项目的画布'))
  expect((await screen.findByRole('link', { name: '其他画布' })).getAttribute('href')).toBe(
    '#/c/other',
  )
  expect(paths).toEqual(['/api/canvases/c', '/api/projects/p/canvases'])
  await act(() => f.queryClient.setQueryData(queryKeys.projectCanvases('p'), []))
  expect(await screen.findByText('这个项目暂时没有可打开的画布。')).toBeTruthy()
})
it('已缓存项目身份的画布读取失败时，重试实际失败的画布请求', async () => {
  let failed = true,
    reads = 0
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/api/canvases/c') {
      reads++
      return failed
        ? Response.json({ message: '画布读取中断' }, { status: 503 })
        : Response.json({ id: 'c', projectId: 'p' })
    }
    if (path === '/api/projects/p/canvases') return Response.json([{ id: 'c', title: '已恢复' }])
  })
  const f = renderApp(<ProductionCanvasIndex canvasId="c" />)
  await act(() =>
    f.queryClient.setQueryData(
      queryKeys.canvas('c'),
      { id: 'c', projectId: 'p' },
      { updatedAt: 1 },
    ),
  )
  await f.user.click(screen.getByText('当前项目的画布'))
  await screen.findByRole('button', { name: '重试读取' })
  expect(reads).toBe(1)
  failed = false
  await f.user.click(screen.getByRole('button', { name: '重试读取' }))
  await waitFor(() => expect(reads).toBe(2))
  await screen.findByRole('link', { name: '已恢复（当前）' })
  expect(screen.queryByRole('button', { name: '重试读取' })).toBeNull()
})

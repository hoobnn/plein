// @vitest-environment happy-dom
import type { Canvas } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { expect, it } from 'vite-plus/test'
import { api } from '../../api/client'
import { cacheCanvas, queryClient, queryKeys } from '../../api/query'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { CanvasInfo } from './CanvasInfo'

const canvas: Canvas = {
  id: 'metadata',
  projectId: 'project',
  title: '当前画布',
  createdAt: 1,
  updatedAt: 1,
}
function Host({ id = canvas.id }: { id?: string }) {
  const query = useQuery({ queryKey: queryKeys.canvas(id), queryFn: () => api.canvas(id) })
  return (
    <>
      <button type="button" aria-label="切换画布">
        {query.data?.title}
      </button>
      <input aria-label="正文" />
      <output>{query.data?.projectId}</output>
      <CanvasInfo key={id} query={query} />
    </>
  )
}

function mockCanvasRead(
  handler: (request: Request) => Response | Promise<Response>,
  ids = [canvas.id],
) {
  return mockFetch((request) => {
    if (
      request.method !== 'GET' ||
      !ids.some((id) => new URL(request.url).pathname === `/api/canvases/${id}`)
    )
      return
    return handler(request)
  })
}

it('首次等待不挡正文输入，错误可原地重试并恢复标题、项目和焦点', async () => {
  let release!: (response: Response) => void
  let reads = 0
  mockCanvasRead(() => {
    reads++
    return new Promise((resolve) => {
      release = resolve
    })
  })
  const { user } = renderApp(<Host />)
  const draft = screen.getByRole<HTMLInputElement>('textbox', { name: '正文' })
  await user.type(draft, '等待时仍可编辑')
  expect(draft.value).toBe('等待时仍可编辑')
  await user.click(screen.getByRole('button', { name: '画布信息正在加载' }))
  expect(screen.getByText('正在读取画布信息…')).toBeTruthy()
  await act(async () => {
    release(Response.json({ message: '画布信息暂不可用' }, { status: 503 }))
  })
  expect((await screen.findByRole('alert')).textContent).toBe('画布信息暂不可用')
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: '重新加载画布信息' })
  await user.click(retry)
  expect(retry.disabled).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe('画布信息暂不可用')
  await act(async () => {
    release(Response.json(canvas))
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(reads).toBe(2)
  expect(draft.value).toBe('等待时仍可编辑')
  expect(screen.getByRole('button', { name: '切换画布' }).textContent).toBe(canvas.title)
  expect(screen.getByRole('status').textContent).toBe(canvas.projectId)
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '切换画布' })),
  )
})

it('缓存刷新失败保留标题；关闭重试面板后迟到成功不抢正文焦点', async () => {
  queryClient.setQueryData(queryKeys.canvas(canvas.id), canvas)
  let fail = true
  let release!: (response: Response) => void
  mockCanvasRead(() =>
    fail
      ? Response.json({ message: '最新信息未读取' }, { status: 503 })
      : new Promise((resolve) => {
          release = resolve
        }),
  )
  const { user } = renderApp(<Host />)
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.canvas(canvas.id) })
  })
  await user.click(await screen.findByRole('button', { name: '画布信息刷新失败' }))
  expect(screen.getByRole('button', { name: '切换画布' }).textContent).toBe(canvas.title)
  expect(screen.getByText(/继续使用已加载的信息/)).toBeTruthy()
  fail = false
  await user.click(screen.getByRole('button', { name: '重新加载画布信息' }))
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: '正文' })
  await user.type(input, '继续编辑的草稿')
  await act(async () => {
    release(Response.json({ ...canvas, title: '后台的新名称' }))
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '切换画布' }).textContent).toBe('后台的新名称'),
  )
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('继续编辑的草稿')
})

it.each([true, false])('切画布后旧信息迟到 success=%s 不改变当前项目', async (success) => {
  let release!: (response: Response) => void
  mockCanvasRead(
    (request) =>
      new URL(request.url).pathname.endsWith('/other')
        ? Response.json({ ...canvas, id: 'other', projectId: 'other-project', title: '另一个画布' })
        : new Promise((resolve) => {
            release = resolve
          }),
    [canvas.id, 'other'],
  )
  const view = renderApp(<Host />)
  await waitFor(() => expect(release).toBeTypeOf('function'))
  view.rerender(<Host id="other" />)
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '切换画布' }).textContent).toBe('另一个画布'),
  )
  await act(async () => {
    release(
      success ? Response.json(canvas) : Response.json({ message: '旧画布失败' }, { status: 503 }),
    )
  })
  await waitFor(() => expect(queryClient.isFetching()).toBe(0))
  expect(screen.getByRole('status').textContent).toBe('other-project')
  expect(screen.queryByRole('button', { name: '画布信息加载失败' })).toBeNull()
})

it('旧读取迟到不回滚已确认的改名，并同步列表缓存', async () => {
  queryClient.setQueryData(queryKeys.canvas(canvas.id), canvas)
  queryClient.setQueryData(queryKeys.projectCanvases(canvas.projectId), [canvas])
  let release!: (response: Response) => void
  mockCanvasRead(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  renderApp(<Host />)
  let refresh!: Promise<void>
  act(() => {
    refresh = queryClient.invalidateQueries({ queryKey: queryKeys.canvas(canvas.id) })
  })
  await waitFor(() => expect(release).toBeTypeOf('function'))
  const renamed = { ...canvas, title: '已确认的新名称' }
  await act(async () => {
    await cacheCanvas(renamed)
    release(Response.json(canvas))
    await refresh
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '切换画布' }).textContent).toBe(renamed.title),
  )
  expect(queryClient.getQueryData(queryKeys.projectCanvases(canvas.projectId))).toEqual([renamed])
})

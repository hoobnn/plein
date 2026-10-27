// @vitest-environment happy-dom
import type { Canvas, Project } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { expect, it } from 'vite-plus/test'
import { api } from '../../api/client'
import { queryKeys } from '../../api/query'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../../testing/render'
import { ProjectSwitcher } from './ProjectSwitcher'

const canvas: Canvas = {
  id: 'canvas-1',
  projectId: 'project-1',
  title: '第一张画布',
  createdAt: 1,
  updatedAt: 1,
}
const project: Project = {
  id: canvas.projectId,
  title: '雨后的项目',
  createdAt: 1,
  updatedAt: 1,
  canvases: 1,
  lastCanvasId: canvas.id,
}

function CurrentCanvas() {
  const query = useQuery({
    queryKey: queryKeys.canvas(canvas.id),
    queryFn: () => api.canvas(canvas.id),
  })
  return query.data && <ProjectSwitcher canvas={query.data} />
}

function setup(write: (request: Request) => Promise<Response> | Response) {
  let current = canvas
  const writes: Request[] = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (
      (request.method === 'POST' && path === '/api/canvases') ||
      (request.method === 'PATCH' && path === `/api/canvases/${canvas.id}`)
    ) {
      writes.push(request)
      const response = await write(request)
      if (response.ok && request.method === 'PATCH')
        current = (await response.clone().json()) as Canvas
      return response
    }
    if (request.method !== 'GET') return
    if (path === `/api/canvases/${canvas.id}`) return Response.json(current)
    if (path === `/api/projects/${project.id}`) return Response.json(project)
    if (path === `/api/projects/${project.id}/canvases`) return Response.json([current])
  })
  useCanvas.setState({ canvasId: canvas.id })
  const rendered = renderApp(<CurrentCanvas />, { route: { name: 'canvas', id: canvas.id } })
  const open = async (kind: 'create' | 'rename') => {
    await rendered.user.click(await screen.findByRole('button', { name: '切换画布' }))
    await rendered.user.click(
      await screen.findByRole('button', {
        name: kind === 'create' ? '新建画布' : '重命名当前画布',
      }),
    )
    const dialog = await screen.findByRole('dialog', {
      name: kind === 'create' ? '新建画布' : '重命名画布',
    })
    return {
      dialog,
      input: within(dialog).getByRole<HTMLInputElement>('textbox'),
      submit: within(dialog).getByRole<HTMLButtonElement>('button', {
        name: kind === 'create' ? '新建' : '保存',
      }),
    }
  }
  return { ...rendered, open, writes }
}

it.each(['create', 'rename'] as const)(
  '%s 失败保留草稿和焦点，修改后重试只提交两次',
  async (kind) => {
    let attempts = 0
    let fail!: (response: Response) => void
    const f = setup(async (request) => {
      const { title } = (await request.json()) as { title: string }
      return ++attempts === 1
        ? new Promise<Response>((resolve) => {
            fail = resolve
          })
        : Response.json({ ...canvas, id: kind === 'create' ? 'new-canvas' : canvas.id, title })
    })
    const { dialog, input, submit } = await f.open(kind)
    await f.user.clear(input)
    await f.user.type(input, '没有丢失的草稿 🌧️')
    await f.user.click(submit)
    await waitFor(() => expect(fail).toBeTypeOf('function'))
    await act(async () => {
      fail(Response.json({ message: '暂时无法保存，请重试' }, { status: 503 }))
    })
    expect((await within(dialog).findByRole('alert')).textContent).toContain('暂时无法保存，请重试')
    expect(input.value).toBe('没有丢失的草稿 🌧️')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(location.hash).toBe('#/c/canvas-1')
    await f.user.clear(input)
    await f.user.type(input, '重试后的名称')
    await f.user.click(submit)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(f.writes).toHaveLength(2)
    expect(await f.writes[1]!.clone().json()).toMatchObject({ title: '重试后的名称' })
    if (kind === 'create') expect(location.hash).toBe('#/c/new-canvas')
    else {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '切换画布' }).textContent).toContain(
          '重试后的名称',
        ),
      )
      await f.user.click(screen.getByRole('button', { name: '切换画布' }))
      expect(
        (await screen.findByRole('button', { name: '重试后的名称' })).getAttribute('aria-current'),
      ).toBe('true')
    }
  },
)

it.each(['create', 'rename'] as const)(
  '%s 等待防重复提交，关闭后迟到成功不接管新草稿',
  async (kind) => {
    let release!: (value: Response) => void
    const f = setup(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const { dialog, input, submit } = await f.open(kind)
    await f.user.clear(input)
    await f.user.type(input, '等待中的名称')
    await f.user.click(submit)
    await waitFor(() => expect(f.writes).toHaveLength(1))
    expect(input.disabled).toBe(true)
    expect(submit.disabled).toBe(true)
    fireEvent.submit(dialog)
    expect(f.writes).toHaveLength(1)
    await f.user.click(within(dialog).getByRole('button', { name: '关闭' }))
    const next = await f.open('create')
    await f.user.clear(next.input)
    await f.user.type(next.input, '新的草稿')
    await act(async () => {
      release(
        Response.json({
          ...canvas,
          id: kind === 'create' ? 'created' : canvas.id,
          title: '等待中的名称',
        }),
      )
    })
    await waitFor(() => expect(f.queryClient.isFetching()).toBe(0))
    expect(screen.getByRole('dialog', { name: '新建画布' })).toBe(next.dialog)
    expect(next.input.value).toBe('新的草稿')
    expect(within(next.dialog).queryByRole('alert')).toBeNull()
    expect(location.hash).toBe('#/c/canvas-1')
    if (kind === 'rename')
      expect(f.queryClient.getQueryData<Canvas>(queryKeys.canvas(canvas.id))?.title).toBe(
        '等待中的名称',
      )
  },
)

it.each(['create', 'rename'] as const)('%s 关闭后的迟到失败不污染新窗口', async (kind) => {
  let release!: (value: Response) => void
  const f = setup(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const first = await f.open(kind)
  await f.user.clear(first.input)
  await f.user.type(first.input, '发送的草稿')
  await f.user.click(first.submit)
  await waitFor(() => expect(f.writes).toHaveLength(1))
  await f.user.click(within(first.dialog).getByRole('button', { name: '关闭' }))
  const next = await f.open('create')
  await act(async () => {
    release(Response.json({ message: '旧请求失败' }, { status: 503 }))
  })
  await waitFor(() => expect(f.queryClient.isFetching()).toBe(0))
  expect(screen.getByRole('dialog', { name: '新建画布' })).toBe(next.dialog)
  expect(within(next.dialog).queryByRole('alert')).toBeNull()
  expect(screen.queryByText('旧请求失败')).toBeNull()
})

it('画布改名的空白、原名称、取消均不提交，组字 Escape 保留草稿', async () => {
  const f = setup(() => {
    throw new Error('不应提交')
  })
  const first = await f.open('rename')
  fireEvent.keyDown(first.input, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog', { name: '重命名画布' })).toBe(first.dialog)
  await f.user.clear(first.input)
  await f.user.type(first.input, '   ')
  expect(first.submit.disabled).toBe(true)
  await f.user.clear(first.input)
  await f.user.type(first.input, canvas.title)
  await f.user.click(first.submit)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const second = await f.open('rename')
  await f.user.type(second.input, '取消')
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(f.writes).toHaveLength(0)
})

it('切走再返回后的迟到改名仍更新缓存，但不改变当前路由', async () => {
  let release!: (value: Response) => void
  const f = setup(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const first = await f.open('rename')
  await f.user.clear(first.input)
  await f.user.type(first.input, '返回后的标题')
  await f.user.click(first.submit)
  await waitFor(() => expect(f.writes).toHaveLength(1))
  await f.user.click(within(first.dialog).getByRole('button', { name: '关闭' }))
  act(() => {
    useCanvas.setState({ canvasId: 'other' })
    useCanvas.setState({ canvasId: canvas.id })
  })
  await act(async () => {
    release(Response.json({ ...canvas, title: '返回后的标题' }))
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '切换画布' }).textContent).toContain('返回后的标题'),
  )
  expect(location.hash).toBe('#/c/canvas-1')
})

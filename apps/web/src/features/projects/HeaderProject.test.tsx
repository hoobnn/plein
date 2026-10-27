// @vitest-environment happy-dom
import type { Canvas, Project } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, screen, waitFor } from '../../testing/render'
import { queryKeys } from '../../api/query'
import { ProjectSwitcher } from './ProjectSwitcher'
import { navigate } from '../../router'

const canvas: Canvas = {
  id: 'canvas-header',
  projectId: 'project-header',
  title: '第一张画布',
  createdAt: 1,
  updatedAt: 1,
}
const project: Project = {
  id: canvas.projectId,
  title: '雨后项目',
  canvases: 1,
  lastCanvasId: canvas.id,
  createdAt: 1,
  updatedAt: 1,
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
function setup(
  read: () => Response | Promise<Response> = () => Response.json(project),
  write?: (body: { title: string }) => Response | Promise<Response>,
) {
  const writes: string[] = []
  mockFetch(async (request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === `/api/projects/${project.id}/canvases`)
      return Response.json([canvas])
    if (request.method === 'GET' && path === `/api/projects/${project.id}`) return read()
    if (request.method === 'PATCH' && path === `/api/projects/${project.id}` && write) {
      const body = (await request.json()) as { title: string }
      writes.push(body.title)
      return write(body)
    }
  })
  useCanvas.setState({ canvasId: canvas.id })
  return {
    ...renderApp(<ProjectSwitcher canvas={canvas} />, { route: { name: 'canvas', id: canvas.id } }),
    writes,
  }
}

async function projectNameInput() {
  // 点击只发起模块加载；等待真实导入和宿主更新后再读取输入框。
  await act(async () => {
    await import('../../ui/DialogView')
  })
  return screen.getByRole<HTMLInputElement>('textbox', { name: '项目名称' })
}

it('首次读取失败可重试，等待时保留错误并禁止重复，成功返回名称入口', async () => {
  const pending = deferred<Response>()
  let reads = 0
  const { user } = setup(() =>
    ++reads === 1 ? Response.json({ message: '项目暂时不可用' }, { status: 503 }) : pending.promise,
  )
  await user.click(await screen.findByRole('button', { name: '项目信息加载失败' }))
  const retry = screen.getByRole<HTMLButtonElement>('button', { name: '重新加载项目信息' })
  expect(screen.getByRole('alert').textContent).toContain('项目暂时不可用')
  await user.click(retry)
  await waitFor(() => expect(reads).toBe(2))
  expect(retry.disabled).toBe(true)
  expect(screen.getByRole('alert').textContent).toContain('项目暂时不可用')
  await act(async () => {
    pending.resolve(Response.json(project))
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: project.title })),
  )
})

it('保持切换器挂载时切项目关闭旧信息弹窗，迟到读取不改写新标题或焦点', async () => {
  const pending = deferred<Response>()
  const nextPending = deferred<Response>()
  const nextCanvas = { ...canvas, id: 'other-canvas', projectId: 'other-project' }
  const nextProject = { ...project, id: nextCanvas.projectId, title: '新项目' }
  mockFetch((request) => {
    if (request.method !== 'GET') return
    const path = new URL(request.url).pathname
    if (path === `/api/projects/${project.id}`) return pending.promise
    if (path === `/api/projects/${nextProject.id}`) return nextPending.promise
    if (path === `/api/projects/${project.id}/canvases`) return Response.json([canvas])
    if (path === `/api/projects/${nextProject.id}/canvases`) return Response.json([nextCanvas])
  })
  useCanvas.setState({ canvasId: canvas.id })
  const { user, rerender, queryClient } = renderApp(<ProjectSwitcher canvas={canvas} />, {
    route: { name: 'canvas', id: canvas.id },
  })
  await user.click(screen.getByRole('button', { name: '项目信息正在加载' }))
  expect(screen.getByRole('status').textContent).toContain('正在读取')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '重新加载项目信息' }).disabled).toBe(
    true,
  )
  act(() => {
    useCanvas.setState({ canvasId: nextCanvas.id })
    navigate({ name: 'canvas', id: nextCanvas.id })
  })
  rerender(<ProjectSwitcher canvas={nextCanvas} />)
  const oldPopupAfterSwitch = screen.queryByRole('dialog', { name: '项目信息' })
  await act(async () => {
    nextPending.resolve(Response.json(nextProject))
  })
  const button = await screen.findByRole('button', { name: nextProject.title })
  button.focus()
  await act(async () => {
    pending.resolve(Response.json(project))
  })
  expect(oldPopupAfterSwitch).toBeNull()
  expect(document.activeElement).toBe(button)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('button', { name: nextProject.title })).toBe(button)
  expect(screen.queryByRole('button', { name: project.title })).toBeNull()
  expect(location.hash).toBe(`#/c/${nextCanvas.id}`)
  expect(queryClient.getQueryData(queryKeys.project(project.id))).toEqual(project)
  expect(queryClient.getQueryData(queryKeys.project(nextProject.id))).toEqual(nextProject)
})

it('缓存刷新失败保留已确认名称，仍可打开改名并重试', async () => {
  let failed = false
  const { user, queryClient } = setup(() =>
    failed ? Response.json({ message: '刷新失败' }, { status: 503 }) : Response.json(project),
  )
  await screen.findByRole('button', { name: project.title })
  await act(() =>
    queryClient.setQueryData(queryKeys.project(project.id), { ...project, title: '已确认新名称' }),
  )
  failed = true
  await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }))
  const title = await screen.findByRole('button', { name: '项目信息刷新失败' })
  expect(title.textContent).toBe('已确认新名称')
  await user.click(title)
  await user.click(screen.getByRole('button', { name: '重命名项目' }))
  expect((await projectNameInput()).value).toBe('已确认新名称')
  await user.click(screen.getByRole('button', { name: '取消' }))
  await user.click(title)
  failed = false
  await user.click(screen.getByRole('button', { name: '重新加载项目信息' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('改名失败保留草稿和焦点，修改后重试只写两次', async () => {
  let saved = project
  let attempts = 0
  const { user, writes } = setup(
    () => Response.json(saved),
    (body) => {
      if (++attempts === 1) return Response.json({ message: '名称暂时无法保存' }, { status: 503 })
      saved = { ...project, title: body.title }
      return Response.json(saved)
    },
  )
  await user.click(await screen.findByRole('button', { name: project.title }))
  const input = await projectNameInput()
  await user.clear(input)
  await user.type(input, '草稿 🌧️')
  await user.keyboard('{Enter}')
  expect((await screen.findByRole('alert')).textContent).toContain('名称暂时无法保存')
  expect(input.value).toBe('草稿 🌧️')
  await waitFor(() => expect(document.activeElement).toBe(input))
  await user.clear(input)
  await user.type(input, '重试成功')
  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(await screen.findByRole('button', { name: '重试成功' })).toBeTruthy()
  expect(writes).toEqual(['草稿 🌧️', '重试成功'])
})

it('保存中禁用重复提交，主动关闭后迟到成功仍更新原项目', async () => {
  const pending = deferred<Response>()
  let saved = project
  const { user, writes } = setup(
    () => Response.json(saved),
    () => pending.promise,
  )
  await user.click(await screen.findByRole('button', { name: project.title }))
  const input = await projectNameInput()
  await user.clear(input)
  await user.type(input, '保存中项目')
  await user.keyboard('{Enter}')
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(input.disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存中…' }).disabled).toBe(true)
  await user.keyboard('{Enter}')
  expect(writes).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: '关闭' }))
  saved = { ...project, title: '保存中项目' }
  await act(async () => {
    pending.resolve(Response.json(saved))
  })
  expect(await screen.findByRole('button', { name: saved.title })).toBeTruthy()
})

it.each([false, true])('确认前离开画布（返回=%s），旧草稿不写入', async (returned) => {
  const { user, writes } = setup(undefined, () => Response.json(project))
  await user.click(await screen.findByRole('button', { name: project.title }))
  const input = await projectNameInput()
  await user.clear(input)
  await user.type(input, '旧草稿')
  act(() => useCanvas.setState({ canvasId: 'other' }))
  if (returned) act(() => useCanvas.setState({ canvasId: canvas.id, engine: {} as never }))
  await user.click(screen.getByRole('button', { name: '保存' }))
  expect((await screen.findByRole('alert')).textContent).toContain('画布已切换')
  expect(input.value).toBe('旧草稿')
  expect(writes).toEqual([])
})

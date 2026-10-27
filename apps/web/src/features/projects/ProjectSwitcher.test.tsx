// @vitest-environment happy-dom
import type { Canvas, Project } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { navigate } from '../../router'
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

async function setup() {
  const fetch = mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === `/api/projects/${project.id}`)
      return Response.json(project)
    if (request.method === 'GET' && path === `/api/projects/${project.id}/canvases`)
      return Response.json([canvas])
  })
  useCanvas.setState({ canvasId: canvas.id })
  const { user } = renderApp(<ProjectSwitcher canvas={canvas} />, {
    route: { name: 'canvas', id: canvas.id },
  })
  await user.click(await screen.findByRole('button', { name: project.title }))
  const dialog = await screen.findByRole('dialog', { name: '重命名项目' })
  const input = within(dialog).getByRole<HTMLInputElement>('textbox', { name: '项目名称' })
  const writes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
  return { user, dialog, input, writes }
}

it('项目改名空白不可保存，原名称确认不提交', async () => {
  const { user, dialog, input, writes } = await setup()
  await user.clear(input)
  await user.type(input, '   ')
  expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(
    true,
  )
  await user.keyboard('{Enter}')
  expect(screen.getByRole('dialog', { name: '重命名项目' })).toBe(dialog)
  expect(writes()).toHaveLength(0)

  await user.clear(input)
  await user.type(input, project.title)
  await user.click(within(dialog).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes()).toHaveLength(0)
})

it('项目改名组字结束的 Esc 229 不丢弃输入，普通取消不写入', async () => {
  const { user, dialog, input, writes } = await setup()
  await user.clear(input)
  await user.type(input, '中文组字中的项目名称')
  for (const composing of [{ keyCode: 229 }, { isComposing: true }]) {
    fireEvent.keyDown(input, { key: 'Escape', ...composing })
    expect(screen.getByRole('dialog', { name: '重命名项目' })).toBe(dialog)
    expect(dialog.hasAttribute('data-closing')).toBe(false)
    expect(input.value).toBe('中文组字中的项目名称')
  }
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(writes()).toHaveLength(0)
})

// ── 画布清单：加载、刷新、切换、同名区分、新建与删除 ──

const secondCanvas: Canvas = {
  id: 'canvas-2',
  projectId: 'project-1',
  title: '另一张画布',
  createdAt: 2,
  updatedAt: 2,
}

interface SwitcherHarness {
  fetch: ReturnType<typeof mockFetch>
  user: ReturnType<typeof renderApp>['user']
  menu: HTMLElement
  unmount(): void
}

/** 渲染切换器并打开画布下拉 */
async function openMenu(
  canvases: Canvas[] = [canvas],
  routes: Record<
    string,
    (request: Request, url: URL) => Response | Promise<Response> | undefined
  > = {},
): Promise<SwitcherHarness> {
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    const route = routes[`${request.method} ${url.pathname}`]
    if (route) return route(request, url)
    if (request.method === 'GET' && url.pathname === `/api/projects/${project.id}`)
      return Response.json(project)
    if (request.method === 'GET' && url.pathname === `/api/projects/${project.id}/canvases`)
      return Response.json(canvases)
  })
  useCanvas.setState({ canvasId: canvas.id })
  const rendered = renderApp(<ProjectSwitcher canvas={canvas} />, {
    route: { name: 'canvas', id: canvas.id },
  })
  const { user } = rendered
  await user.click(await screen.findByRole('button', { name: '切换画布' }))
  const menu = await screen.findByRole('dialog', { name: '画布' })
  return { fetch, user, menu, unmount: () => rendered.unmount() }
}

it('画布清单首次加载等待有反馈，完成后可切换', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await openMenu([canvas, secondCanvas], {
    [`GET /api/projects/${project.id}/canvases`]: () => held,
  })
  expect(f.menu.textContent).toContain('正在加载画布')
  await act(async () => release(Response.json([canvas, secondCanvas])))
  await waitFor(() =>
    expect(within(f.menu).getByRole('button', { name: secondCanvas.title })).toBeTruthy(),
  )
  expect(within(f.menu).queryByRole('status')).toBeNull()
  await f.user.click(within(f.menu).getByRole('button', { name: secondCanvas.title }))
  await waitFor(() => expect(location.hash).toBe(`#/c/${secondCanvas.id}`))
})

it('画布清单首次失败可直接重试，等待时不重复读取', async () => {
  let fail = true
  let reads = 0
  const f = await openMenu([canvas, secondCanvas], {
    [`GET /api/projects/${project.id}/canvases`]: () => {
      reads++
      return fail
        ? Response.json({ message: '画布清单暂时不可用' }, { status: 503 })
        : Response.json([canvas, secondCanvas])
    },
  })
  const error = await within(f.menu).findByRole('alert')
  expect(error.textContent).toContain('画布清单暂时不可用')
  fail = false
  const retry = within(error).getByRole('button', { name: '重新加载画布' })
  retry.click()
  retry.click()
  await waitFor(() => expect(reads).toBe(2))
  expect((retry as HTMLButtonElement).disabled).toBe(true)
  await waitFor(() => expect(within(f.menu).queryByRole('alert')).toBeNull())
  expect(within(f.menu).getByRole('button', { name: secondCanvas.title })).toBeTruthy()
})

it('刷新失败保留已有选项，重试不改选也不动文档', async () => {
  let fail = false
  const first = await openMenu([canvas, secondCanvas])
  await within(first.menu).findByRole('button', { name: secondCanvas.title })
  await first.user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '画布' })).toBeNull())
  first.unmount()
  fail = true
  const f = await openMenu([canvas, secondCanvas], {
    [`GET /api/projects/${project.id}/canvases`]: () =>
      fail
        ? Response.json({ message: '刷新画布失败' }, { status: 503 })
        : Response.json([canvas, secondCanvas]),
  })
  const error = await within(f.menu).findByRole('alert')
  expect(error.textContent).toContain('画布列表刷新失败：刷新画布失败')
  // 已有选项仍在，当前画布标记不变
  expect(within(f.menu).getByRole('button', { name: canvas.title })).toBeTruthy()
  expect(
    within(f.menu).getByRole('button', { name: canvas.title }).getAttribute('aria-current'),
  ).toBe('true')
  fail = false
  await f.user.click(within(error).getByRole('button', { name: '重新加载画布' }))
  await waitFor(() => expect(within(f.menu).queryByRole('alert')).toBeNull())
  expect(location.hash).toBe(`#/c/${canvas.id}`)
  await f.user.keyboard('{Escape}')
  await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('切换画布'))
})

it('同名画布显示唯一短 ID，当前标记按真实身份区分', async () => {
  const sameTitle = '同名画布 · 一'
  const a: Canvas = { ...canvas, title: sameTitle }
  const b: Canvas = { ...secondCanvas, title: sameTitle }
  const f = await openMenu([a, b])
  const current = within(f.menu).getByRole('button', {
    name: `${sameTitle} · ${a.id.slice(-6)}`,
  })
  const other = within(f.menu).getByRole('button', {
    name: `${sameTitle} · ${b.id.slice(-6)}`,
  })
  expect(current.getAttribute('aria-current')).toBe('true')
  expect(other.hasAttribute('aria-current')).toBe(false)
  await f.user.click(other)
  await waitFor(() => expect(location.hash).toBe(`#/c/${b.id}`))
})

it('空画布清单说明现状，仍可新建画布继续', async () => {
  const f = await openMenu([])
  await waitFor(() => expect(f.menu.textContent).toContain('暂无可切换的画布'))
  expect(within(f.menu).queryByRole('alert')).toBeNull()
  await f.user.click(within(f.menu).getByRole('button', { name: '新建画布' }))
  const dialog = await screen.findByRole('dialog', { name: '新建画布' })
  const created: Canvas = { ...secondCanvas, title: '空清单后新建' }
  const submit = within(dialog).getByRole('button', { name: '新建' })
  await f.user.type(within(dialog).getByRole('textbox'), '空清单后新建')
  f.fetch.mockImplementationOnce(() => Promise.resolve(Response.json(created)))
  await f.user.click(submit)
  await waitFor(() => expect(location.hash).toBe(`#/c/${created.id}`))
})

it('新建画布迟到应答：关闭窗口或切走后不接管导航，列表仍刷新', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await openMenu([canvas, secondCanvas], {
    'POST /api/canvases': () => held,
  })
  await f.user.click(within(f.menu).getByRole('button', { name: '新建画布' }))
  const dialog = await screen.findByRole('dialog', { name: '新建画布' })
  await f.user.type(within(dialog).getByRole('textbox'), '迟到的新画布')
  await f.user.click(within(dialog).getByRole('button', { name: '新建' }))
  // 确认等待中窗口不消失；主动关闭后创建继续，但不再接管导航
  expect(screen.getByRole('dialog', { name: '新建画布' })).toBe(dialog)
  await f.user.click(within(dialog).getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建画布' })).toBeNull())
  // 等待期间切到其他画布
  navigate({ name: 'canvas', id: secondCanvas.id })
  const created: Canvas = { ...secondCanvas, id: 'canvas-3', title: '迟到的新画布' }
  const reads = () =>
    f.fetch.mock.calls.filter(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input : (input as Request).url, location.href)
      return (
        (init?.method ?? 'GET') === 'GET' && url.pathname === `/api/projects/${project.id}/canvases`
      )
    }).length
  await act(async () => release(Response.json(created)))
  // 迟到的创建不导航，但项目画布清单已失效重拉
  await waitFor(() => expect(reads()).toBeGreaterThan(1))
  expect(location.hash).toBe(`#/c/${secondCanvas.id}`)
})

it('删除当前画布成功后切到下一张画布', async () => {
  const f = await openMenu([canvas, secondCanvas], {
    [`DELETE /api/canvases/${canvas.id}`]: () => new Response(null, { status: 204 }),
  })
  await f.user.click(within(f.menu).getByRole('button', { name: '删除当前画布' }))
  const dialog = await screen.findByRole('dialog', { name: `删除画布「${canvas.title}」？` })
  await f.user.click(within(dialog).getByRole('button', { name: '删除' }))
  await waitFor(() => expect(location.hash).toBe(`#/c/${secondCanvas.id}`))
})

it('删除最后一张画布成功后回首页', async () => {
  const f = await openMenu([canvas], {
    [`DELETE /api/canvases/${canvas.id}`]: () => new Response(null, { status: 204 }),
  })
  await f.user.click(within(f.menu).getByRole('button', { name: '删除当前画布' }))
  const dialog = await screen.findByRole('dialog', { name: `删除画布「${canvas.title}」？` })
  await f.user.click(within(dialog).getByRole('button', { name: '删除' }))
  await waitFor(() => expect(location.hash).toBe('#/'))
})

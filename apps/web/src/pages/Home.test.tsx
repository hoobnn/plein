// @vitest-environment happy-dom
import { LOCAL_PRINCIPAL, type Project } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { queryClient, queryKeys } from '../api/query'
import { useCanvas } from '../stores/canvas'
import { useSession } from '../stores/session'
import { mockFetch } from '../testing/fetch'
import { act, fireEvent, renderApp, screen, waitFor, within } from '../testing/render'
import { Home } from './Home'

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p-1',
  title: '雨后的项目',
  createdAt: 1,
  updatedAt: 1,
  canvases: 1,
  lastCanvasId: 'canvas-1',
  covers: ['/plein-icon.png'],
  ...over,
})

type MockFetch = ReturnType<typeof mockFetch>
type Route = (request: Request, url: URL) => Response | Promise<Response> | undefined

/** 按方法与路径统计请求次数；未写 method 的读取按 GET 处理 */
const callsOf = (fetch: MockFetch, method: string, path: string) =>
  fetch.mock.calls.filter(([input, init]) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url, location.href)
    return (init?.method ?? 'GET') === method && url.pathname === path
  }).length

/** 首页测试里的可变项目状态：路由改写后，后续列表读取按它回放 */
interface State {
  projects: Project[]
}

/** 渲染首页；未单独声明的读取返回项目列表与空目录，路由可改写 state.projects */
async function setup(
  projects: Project[],
  makeRoutes: (state: State) => Record<string, Route> = () => ({}),
) {
  const state: State = { projects: [...projects] }
  const routes = makeRoutes(state)
  const fetch = mockFetch((request) => {
    const url = new URL(request.url)
    const route = routes[`${request.method} ${url.pathname}`]
    if (route) return route(request, url)
    if (request.method === 'GET' && url.pathname === '/api/projects')
      return Response.json(state.projects)
    if (request.method === 'GET' && url.pathname === '/api/catalog')
      return Response.json({ providers: [] })
  })
  useSession.setState({
    status: 'ready',
    info: { principal: LOCAL_PRINCIPAL, authRequired: false, needsSetup: false },
  })
  localStorage.setItem('plein.welcome', '1')
  const rendered = renderApp(<Home onOpenSettings={() => {}} />)
  const mount = () => renderApp(<Home onOpenSettings={() => {}} />)
  return {
    fetch,
    state,
    user: rendered.user,
    /** 离开首页后再回来：卸载旧的，挂一个全新的首页 */
    remountHome: () => {
      rendered.unmount()
      return mount()
    },
    unmountHome: () => rendered.unmount(),
  }
}

const cardOf = async (title: string) =>
  (await screen.findByRole('link', { name: title })).closest('li') as HTMLElement

const disabled = (el: Element) => (el as HTMLButtonElement).disabled

const confirmDelete = async (user: Awaited<ReturnType<typeof setup>>['user']) => {
  const dialog = await screen.findByRole('dialog', { name: /删除项目/ })
  await user.click(within(dialog).getByRole('button', { name: '删除' }))
}

/** 项目改名路由：更新状态并返回不带封面的应答（验证列表展示数据不被覆盖） */
const renameRoute =
  (state: State, id = 'p-1'): Route =>
  async (request) => {
    const { title } = (await request.json()) as { title: string }
    state.projects = state.projects.map((item) => (item.id === id ? { ...item, title } : item))
    return Response.json({ ...project(), title, covers: undefined })
  }

/** 删除项目路由：成功时从状态里移除 */
const deleteRoute =
  (state: State, id: string, outcome: () => Response | Promise<Response>): Route =>
  async () => {
    const response = await outcome()
    if (response.ok) state.projects = state.projects.filter((item) => item.id !== id)
    return response
  }

const createButton = () => screen.getByRole('button', { name: '新建项目' })
it('新建项目等待时说明状态并禁用入口，重复点击只创建一次', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await setup([project()], () => ({ 'POST /api/projects': () => held }))
  const button = createButton()
  // 同一帧内连点两次：还没等重渲染把按钮禁用，防重入只能靠逻辑层
  act(() => {
    button.click()
    button.click()
  })
  await waitFor(() => expect(callsOf(f.fetch, 'POST', '/api/projects')).toBe(1))
  // 首页加载中也有一个 status（「正在加载项目…」），只认创建状态
  expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('正在创建项目'))).toBe(
    true,
  )
  for (const name of ['新建项目', /短剧模板/, /图片生成/])
    expect(disabled(screen.getByRole('button', { name }))).toBe(true)
  await act(async () => release(Response.json(project({ id: 'p-2', lastCanvasId: 'canvas-2' }))))
  await waitFor(() => expect(location.hash).toBe('#/c/canvas-2'))
  expect(callsOf(f.fetch, 'POST', '/api/projects')).toBe(1)
})

it('创建失败说明原因并恢复入口，重试成功不再残留错误', async () => {
  let fail = true
  const f = await setup([project()], () => ({
    'POST /api/projects': () =>
      fail
        ? Response.json({ message: '创建暂不可用' }, { status: 503 })
        : Response.json(project({ id: 'p-2', lastCanvasId: 'canvas-2' })),
  }))
  await f.user.click(screen.getByRole('button', { name: /图片生成/ }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('创建暂不可用'))
  expect(disabled(createButton())).toBe(false)
  fail = false
  await f.user.click(createButton())
  await waitFor(() => expect(location.hash).toBe('#/c/canvas-2'))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(callsOf(f.fetch, 'POST', '/api/projects')).toBe(2)
})

it('离开首页后迟到的创建成功只提示，不接管导航', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await setup([project()], () => ({ 'POST /api/projects': () => held }))
  await f.user.click(screen.getByRole('button', { name: /剧本创作/ }))
  await waitFor(() => expect(callsOf(f.fetch, 'POST', '/api/projects')).toBe(1))
  f.unmountHome()
  await act(async () =>
    release(Response.json(project({ id: 'p-2', title: '迟到的新项目', lastCanvasId: 'canvas-2' }))),
  )
  await waitFor(() => expect(useCanvas.getState().notice).toBe('已创建项目「迟到的新项目」'))
  expect(location.hash).toBe('#/')
  // 列表缓存里已经能看到新项目，回首页不用等刷新
  await waitFor(() =>
    expect(queryClient.getQueryData<Project[]>(queryKeys.projects)?.[0]?.id).toBe('p-2'),
  )
})

it('离开首页后创建失败仍说明原因，重新进入后可再次创建', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  let writes = 0
  const f = await setup([project()], () => ({
    'POST /api/projects': () => {
      writes++
      return writes === 1 ? held : Response.json(project({ id: 'p-2', lastCanvasId: 'c2' }))
    },
  }))
  await f.user.click(createButton())
  await waitFor(() => expect(writes).toBe(1))
  f.unmountHome()
  await act(async () => release(Response.json({ message: '创建连接中断' }, { status: 503 })))
  await waitFor(() => expect(useCanvas.getState().notice).toBe('创建项目未获确认：创建连接中断'))
  const again = f.remountHome()
  await waitFor(() => expect(disabled(createButton())).toBe(false))
  await again.user.click(createButton())
  await waitFor(() => expect(location.hash).toBe('#/c/c2'))
  expect(writes).toBe(2)
})

it('首次加载项目失败可在原地重试，等待期间不重复读取', async () => {
  let fail = true
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let reads = 0
  const f = await setup([project()], (state) => ({
    'GET /api/projects': () => {
      reads++
      if (fail) return Response.json({ message: '首次项目加载失败' }, { status: 503 })
      if (reads === 2) return held.then(() => Response.json(state.projects))
      return Response.json(state.projects)
    },
  }))
  const error = await screen.findByRole('alert')
  expect(error.textContent).toContain('项目列表加载失败：首次项目加载失败')
  fail = false
  const retry = within(error).getByRole('button', { name: '重新加载项目' })
  await f.user.click(retry)
  await f.user.click(retry)
  await waitFor(() => expect(reads).toBe(2))
  expect(disabled(retry)).toBe(true)
  await act(async () => release())
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByRole('link', { name: '雨后的项目' })).toBeTruthy()
  expect(reads).toBe(2)
})

it('改名成功但列表刷新失败：保留新名与封面，重试后恢复', async () => {
  let failList = false
  const f = await setup([project()], (state) => ({
    'PATCH /api/projects/p-1': renameRoute(state),
    'GET /api/projects': () =>
      failList
        ? Response.json({ message: '项目列表暂时不可用' }, { status: 503 })
        : Response.json(state.projects),
  }))
  const card = await cardOf('雨后的项目')
  failList = true
  await f.user.click(within(card).getByRole('button', { name: '重命名' }))
  const input = within(card).getByRole('textbox', { name: '项目名称' })
  await f.user.clear(input)
  await f.user.type(input, '已经保存的新名称')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(within(card).getByRole('link', { name: '已经保存的新名称' })).toBeTruthy(),
  )
  // 改名应答不带 covers，卡片上的封面不能丢
  expect(card.querySelector('.home-cover img')).toBeTruthy()
  const error = await screen.findByRole('alert', undefined, { timeout: 3000 })
  expect(error.textContent).toContain('项目列表刷新失败：项目列表暂时不可用')
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(1)
  failList = false
  await f.user.click(within(error).getByRole('button', { name: '重新加载项目' }))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(screen.getByRole('link', { name: '已经保存的新名称' })).toBeTruthy()
})

it('改名失败保留草稿与焦点，修正后重试成功', async () => {
  let fail = true
  const f = await setup([project()], (state) => ({
    'PATCH /api/projects/p-1': () => {
      if (fail) return Response.json({ message: '项目改名暂时失败，请重试' }, { status: 503 })
      state.projects = state.projects.map((item) =>
        item.id === 'p-1' ? { ...item, title: '雨后清晨 🌧️ 重试成功' } : item,
      )
      return Response.json({ ...project(), title: '雨后清晨 🌧️ 重试成功' })
    },
  }))
  const card = await cardOf('雨后的项目')
  await f.user.click(within(card).getByRole('button', { name: '重命名' }))
  const input = within(card).getByRole('textbox', { name: '项目名称' })
  await f.user.clear(input)
  await f.user.type(input, '雨后清晨 🌧️ 未丢失的名称')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(await within(card).findByRole('alert')).toBeTruthy()
  expect(within(card).getByRole('alert').textContent).toContain('项目改名暂时失败，请重试')
  const draft = within(card).getByRole<HTMLInputElement>('textbox', { name: '项目名称' })
  expect(draft.value).toBe('雨后清晨 🌧️ 未丢失的名称')
  expect(document.activeElement).toBe(draft)
  fail = false
  await f.user.clear(draft)
  await f.user.type(draft, '雨后清晨 🌧️ 重试成功')
  fireEvent.keyDown(draft, { key: 'Enter' })
  await waitFor(() =>
    expect(within(card).getByRole('link', { name: '雨后清晨 🌧️ 重试成功' })).toBeTruthy(),
  )
  expect(within(card).queryByRole('alert')).toBeNull()
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(2)
})

it('改名保存中显示状态并禁用竞争操作，只提交一次', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await setup([project()], () => ({ 'PATCH /api/projects/p-1': () => held }))
  const card = await cardOf('雨后的项目')
  const rename = within(card).getByRole('button', { name: '重命名' })
  await f.user.click(rename)
  const input = within(card).getByRole('textbox', { name: '项目名称' })
  await f.user.clear(input)
  await f.user.type(input, '等待保存的项目')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(1))
  expect(within(card).getByRole('status').textContent).toContain('正在保存项目名称')
  expect(disabled(rename)).toBe(true)
  expect(disabled(within(card).getByRole('button', { name: '删除' }))).toBe(true)
  f.state.projects = f.state.projects.map((item) =>
    item.id === 'p-1' ? { ...item, title: '等待保存的项目' } : item,
  )
  await act(async () => release(Response.json({ ...project(), title: '等待保存的项目' })))
  await waitFor(() =>
    expect(within(card).getByRole('link', { name: '等待保存的项目' })).toBeTruthy(),
  )
  expect(within(card).queryByRole('status')).toBeNull()
  expect(disabled(rename)).toBe(false)
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(1)
})

it('Esc 与空白名称不写入，确认保存只提交一次', async () => {
  const f = await setup([project()], (state) => ({
    'PATCH /api/projects/p-1': renameRoute(state),
  }))
  const card = await cardOf('雨后的项目')
  const rename = within(card).getByRole('button', { name: '重命名' })
  for (const [fill, key] of [
    ['应丢弃的名称', 'Escape'],
    ['   ', 'Enter'],
  ] as const) {
    await f.user.click(rename)
    const input = within(card).getByRole('textbox', { name: '项目名称' })
    await f.user.clear(input)
    await f.user.type(input, fill)
    fireEvent.keyDown(input, { key })
    await waitFor(() => expect(within(card).queryByRole('textbox')).toBeNull())
  }
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(0)
  await f.user.click(rename)
  const input = within(card).getByRole('textbox', { name: '项目名称' })
  await f.user.clear(input)
  await f.user.type(input, '  一次保存  ')
  fireEvent.keyDown(input, { key: 'Enter' })
  await f.user.click(screen.getByRole('heading', { name: /我的项目/ }))
  await waitFor(() => expect(within(card).getByRole('link', { name: '一次保存' })).toBeTruthy())
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(1)
})

it('改名迟到失败恢复草稿，但不抢走搜索框焦点', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await setup([project(), project({ id: 'p-2', title: '第二个项目' })], () => ({
    'PATCH /api/projects/p-1': () => held,
  }))
  const card = await cardOf('雨后的项目')
  await f.user.click(within(card).getByRole('button', { name: '重命名' }))
  const input = within(card).getByRole('textbox', { name: '项目名称' })
  await f.user.clear(input)
  await f.user.type(input, '保留草稿且不打断其他操作')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(1))
  const search = screen.getByRole('searchbox', { name: '搜索项目' })
  search.focus()
  await act(async () => release(Response.json({ message: '迟到的改名失败' }, { status: 503 })))
  expect(await within(card).findByRole('alert')).toBeTruthy()
  await waitFor(() => expect(within(card).getByRole('textbox', { name: '项目名称' })).toBeTruthy())
  expect(document.activeElement).toBe(search)
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(1)
})

it('改名输入的组字键 229 不提交也不取消', async () => {
  const f = await setup([project()], (state) => ({
    'PATCH /api/projects/p-1': renameRoute(state),
  }))
  const card = await cardOf('雨后的项目')
  await f.user.click(within(card).getByRole('button', { name: '重命名' }))
  const input = within(card).getByRole<HTMLInputElement>('textbox', { name: '项目名称' })
  await f.user.clear(input)
  await f.user.type(input, '组字后的项目名称')
  for (const key of ['Enter', 'Escape'])
    fireEvent.keyDown(input, { key, keyCode: 229, isComposing: false })
  expect(within(card).getByRole('textbox', { name: '项目名称' })).toBe(input)
  expect(input.value).toBe('组字后的项目名称')
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(0)
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(within(card).getByRole('link', { name: '组字后的项目名称' })).toBeTruthy(),
  )
})

it('删除确认取消或 Esc 不发写入请求，焦点回到删除按钮', async () => {
  const f = await setup([project()])
  const card = await cardOf('雨后的项目')
  const remove = within(card).getByRole('button', { name: '删除' })
  for (const close of ['cancel', 'escape'] as const) {
    await f.user.click(remove)
    const dialog = await screen.findByRole('dialog', { name: /删除项目/ })
    if (close === 'cancel') await f.user.click(within(dialog).getByRole('button', { name: '取消' }))
    else fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(disabled(remove)).toBe(false)
    expect(document.activeElement).toBe(remove)
  }
  expect(callsOf(f.fetch, 'DELETE', '/api/projects/p-1')).toBe(0)
  expect(callsOf(f.fetch, 'GET', '/api/projects/p-1/canvases')).toBe(0)
})

it('删除失败在原卡片说明原因，项目仍可打开，重试删除成功', async () => {
  let writes = 0
  const f = await setup([project()], (state) => ({
    'GET /api/projects/p-1/canvases': () => Response.json([]),
    'DELETE /api/projects/p-1': deleteRoute(state, 'p-1', () => {
      writes++
      return writes === 1
        ? Response.json({ message: '项目删除暂时失败，请重试' }, { status: 503 })
        : new Response(null, { status: 204 })
    }),
  }))
  const card = await cardOf('雨后的项目')
  const remove = within(card).getByRole('button', { name: '删除' })
  await f.user.click(remove)
  await confirmDelete(f.user)
  expect(await within(card).findByRole('alert')).toBeTruthy()
  expect(within(card).getByRole('alert').textContent).toContain('项目删除暂时失败，请重试')
  expect(disabled(remove)).toBe(false)
  // 删除没成功时项目还能打开
  await f.user.click(within(card).getAllByRole('link').at(-1)!)
  await waitFor(() => expect(location.hash).toBe('#/c/canvas-1'))
  expect(writes).toBe(1)
})

it('删除前清单读取失败保留项目，不发出删除请求', async () => {
  let lists = 0
  const f = await setup([project()], (state) => ({
    'GET /api/projects/p-1/canvases': () => {
      lists++
      return lists === 1
        ? Response.json({ message: '画布清单暂时不可用' }, { status: 503 })
        : Response.json([])
    },
    'DELETE /api/projects/p-1': deleteRoute(
      state,
      'p-1',
      () => new Response(null, { status: 204 }),
    ),
  }))
  const card = await cardOf('雨后的项目')
  await f.user.click(within(card).getByRole('button', { name: '删除' }))
  await confirmDelete(f.user)
  expect(await within(card).findByRole('alert')).toBeTruthy()
  expect(within(card).getByRole('alert').textContent).toContain('画布清单暂时不可用')
  expect(callsOf(f.fetch, 'DELETE', '/api/projects/p-1')).toBe(0)
  expect(callsOf(f.fetch, 'GET', '/api/projects/p-1/canvases')).toBe(1)
  await f.user.click(within(card).getByRole('button', { name: '删除' }))
  await confirmDelete(f.user)
  await waitFor(() => expect(card.isConnected).toBe(false))
  expect(callsOf(f.fetch, 'DELETE', '/api/projects/p-1')).toBe(1)
})

it('删除等待中禁用竞争操作，标题点击不离开首页', async () => {
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await setup([project()], (state) => ({
    'GET /api/projects/p-1/canvases': () => Response.json([]),
    'DELETE /api/projects/p-1': deleteRoute(state, 'p-1', () => held),
  }))
  const card = await cardOf('雨后的项目')
  await f.user.click(within(card).getByRole('button', { name: '删除' }))
  await confirmDelete(f.user)
  await waitFor(() => expect(callsOf(f.fetch, 'DELETE', '/api/projects/p-1')).toBe(1))
  expect(within(card).getByRole('status').textContent).toContain('正在删除项目')
  for (const name of ['删除', '重命名', '导出项目包', '项目素材', '项目检查点'])
    expect(disabled(within(card).getByRole('button', { name }))).toBe(true)
  const title = within(card).getAllByRole('link').at(-1)!
  expect(title.getAttribute('aria-disabled')).toBe('true')
  await f.user.click(title)
  expect(location.hash).toBe('#/')
  await act(async () => release(new Response(null, { status: 204 })))
  await waitFor(() => expect(card.isConnected).toBe(false))
  expect(callsOf(f.fetch, 'DELETE', '/api/projects/p-1')).toBe(1)
})

it('筛选后删除匹配项目，清除搜索恢复其余项目', async () => {
  const f = await setup(
    [
      project({ id: 'keep', title: '保留的项目', lastCanvasId: 'c-keep' }),
      project({ id: 'gone', title: '搜索后删除的项目', lastCanvasId: 'c-gone' }),
    ],
    (state) => ({
      'GET /api/projects/gone/canvases': () => Response.json([]),
      'DELETE /api/projects/gone': deleteRoute(
        state,
        'gone',
        () => new Response(null, { status: 204 }),
      ),
    }),
  )
  const search = await screen.findByRole('searchbox', { name: '搜索项目' })
  await f.user.type(search, '搜索后删除')
  const card = await cardOf('搜索后删除的项目')
  expect(screen.queryByRole('link', { name: '保留的项目' })).toBeNull()
  await f.user.click(within(card).getByRole('button', { name: '删除' }))
  await confirmDelete(f.user)
  await waitFor(() => expect(card.isConnected).toBe(false))
  await f.user.clear(search)
  await waitFor(() => expect(screen.getByRole('link', { name: '保留的项目' })).toBeTruthy())
})

it('快速开始等待期间防重复，失败后可从同一入口重试', async () => {
  let writes = 0
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  const f = await setup([project()], () => ({
    'POST /api/projects': () => {
      writes++
      return writes === 1 ? held : Response.json(project({ id: 'p-2', lastCanvasId: 'c2' }))
    },
  }))
  const button = screen.getByRole('button', { name: /短剧模板/ })
  act(() => {
    button.click()
    button.click()
  })
  await waitFor(() => expect(writes).toBe(1))
  expect(disabled(button)).toBe(true)
  expect(screen.getAllByRole('status').some((el) => el.textContent?.includes('正在创建项目'))).toBe(
    true,
  )
  await act(async () => release(Response.json({ message: '短剧项目暂不可用' }, { status: 503 })))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('短剧项目暂不可用')
  await waitFor(() => expect(disabled(button)).toBe(false))
  await f.user.click(button)
  await waitFor(() => expect(location.hash).toBe('#/c/c2'))
  expect(writes).toBe(2)
})

it('改名后迟到的旧列表不覆盖已确认的名称', async () => {
  // 回首页时先显示缓存的项目（查询正在重拉）；改名确认后，挂起的旧列表响应迟到
  queryClient.setQueryData(queryKeys.projects, [project()])
  let release!: (r: Response) => void
  const held = new Promise<Response>((resolve) => {
    release = resolve
  })
  let reads = 0
  const f = await setup([project()], (state) => ({
    'PATCH /api/projects/p-1': async (request) => {
      const { title } = (await request.json()) as { title: string }
      state.projects = state.projects.map((item) => (item.id === 'p-1' ? { ...item, title } : item))
      return Response.json({ ...project(), title, covers: undefined })
    },
    'GET /api/projects': () => {
      reads++
      // 挂起的是回首页后的第一次重拉；改名触发的失效重拉按最新状态回放
      if (reads === 1) return held
      return Response.json(state.projects)
    },
  }))
  const card = await cardOf('雨后的项目')
  await f.user.click(within(card).getByRole('button', { name: '重命名' }))
  const input = within(card).getByRole('textbox', { name: '项目名称' })
  await f.user.clear(input)
  await f.user.type(input, '不能被旧列表撤销的名称')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(within(card).getByRole('link', { name: '不能被旧列表撤销的名称' })).toBeTruthy(),
  )
  // 改名触发的失效重拉已经接管了挂起的旧请求；迟到的旧列表不能再覆盖确认写入
  await act(async () => release(Response.json([project()])))
  await act(async () => {})
  await waitFor(() =>
    expect(within(card).getByRole('link', { name: '不能被旧列表撤销的名称' })).toBeTruthy(),
  )
  expect(callsOf(f.fetch, 'PATCH', '/api/projects/p-1')).toBe(1)
})

it('首页助手入口唯一且置于顶栏', async () => {
  await setup([project()])
  const banner = await screen.findByRole('banner')
  expect(within(banner).getByRole('button', { name: '打开助手' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '打开助手' })).toHaveLength(1)
})

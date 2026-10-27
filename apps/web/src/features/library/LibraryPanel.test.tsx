// @vitest-environment happy-dom
import type { LibraryItem, Project } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { LibraryPanel } from './Library'
import { useLibrary } from './store'

resetStoreAfterEach(useLibrary)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const item = (over: Partial<LibraryItem> & { id: string; name: string }): LibraryItem => ({
  kind: 'prop',
  projectId: null,
  description: '',
  tags: {},
  voice: null,
  images: [],
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const project = (id: string, title: string): Project => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  canvases: 1,
  lastCanvasId: 'cv_1',
})

type Handler = (request: Request) => Response | undefined | Promise<Response | undefined>

/** 打开资产库面板：只回应列表和项目列表，其余请求都要在用例里显式声明。 */
async function openPanel(
  options: {
    items?: LibraryItem[]
    projects?: Project[]
    projectId?: string | null
    kind?: 'prop' | 'character'
    handler?: Handler
  } = {},
) {
  const items = options.items ?? []
  const projects = options.projects ?? []
  const routes: string[] = []
  // 服务端语义：PATCH 只改传入的字段，其余保留
  const saved = new Map(items.map((entry) => [entry.id, { ...entry }]))
  mockFetch(async (request) => {
    const url = new URL(request.url)
    const handled = await options.handler?.(request)
    if (handled) return handled
    routes.push(`${request.method} ${url.pathname}`)
    if (request.method === 'GET' && url.pathname === '/api/library')
      return json([...saved.values()])
    if (request.method === 'GET' && url.pathname === '/api/projects') return json(projects)
    if (request.method === 'PATCH') {
      const id = url.pathname.split('/').pop()!
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as Partial<LibraryItem>
      const next = { ...saved.get(id), ...body } as LibraryItem
      saved.set(id, next)
      return json(next)
    }
    return undefined
  })
  useLibrary.getState().setProject(options.projectId ?? null)
  const view = renderApp(<LibraryPanel />)
  useLibrary.getState().show(options.kind ?? 'prop')
  await screen.findByRole('dialog', { name: '资产库' })
  return { ...view, routes, items }
}

describe('资产库面板的筛选与来源', () => {
  it('搜索没有结果时说明是筛选结果，清空后恢复列表', async () => {
    const { user } = await openPanel({ items: [item({ id: 'lib_1', name: '旧打火机' })] })
    const search = screen.getByRole('searchbox', { name: '搜索道具' })
    await screen.findByText('旧打火机')
    await user.type(search, '不存在的名字')
    expect(await screen.findByText('没有符合条件的道具')).toBeTruthy()
    expect(screen.getByText('试试其他关键词，或清空搜索和筛选。')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '清空搜索和筛选' }))
    expect(await screen.findByText('旧打火机')).toBeTruthy()
  })

  it('重置筛选同时清掉关键词和标签，保留当前范围并把焦点送回搜索框', async () => {
    const items = [
      item({
        id: 'lib_1',
        kind: 'character',
        name: '林夏',
        tags: { gender: '女' },
        favorite: true,
      }),
      item({
        id: 'lib_2',
        kind: 'character',
        name: '陆川',
        tags: { gender: '男' },
        favorite: true,
      }),
      item({ id: 'lib_3', kind: 'character', name: '路人', tags: { gender: '女' } }),
    ]
    const { user } = await openPanel({ kind: 'character', items })
    const scope = within(screen.getByRole('group', { name: '范围' }))
    await user.click(scope.getByRole('button', { name: '收藏' }))
    const search = screen.getByRole('searchbox', { name: '搜索角色' })
    await user.click(screen.getByRole('combobox', { name: '性别' }))
    await user.click(await screen.findByRole('option', { name: '女' }))
    await waitFor(() => expect(screen.queryByText('陆川')).toBeNull())
    await user.type(search, '林夏')
    expect(await screen.findByText('林夏')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重置筛选' }))
    // 关键词和标签都清掉，范围还停在收藏，焦点回到搜索框
    expect(await screen.findByText('陆川')).toBeTruthy()
    expect((search as HTMLInputElement).value).toBe('')
    expect(scope.getByRole('button', { name: '收藏' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('本项目还没有条目时保留新建入口，空白关键词不算筛选', async () => {
    const { user } = await openPanel({ items: [], projectId: 'pj_1' })
    expect(await screen.findByText('这个项目还没有道具')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '新建道具' }).length).toBeGreaterThan(0)
    const search = screen.getByRole('searchbox', { name: '搜索道具' })
    await user.type(search, '   ')
    expect(screen.getByText('这个项目还没有道具')).toBeTruthy()
    await user.clear(search)
    await user.type(search, '不存在的名字')
    expect(await screen.findByText('没有符合条件的道具')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '清空搜索和筛选' }))
    expect(await screen.findByText('这个项目还没有道具')).toBeTruthy()
  })

  it('按标签筛选只剩命中的资产，重置后全部回来', async () => {
    const { user } = await openPanel({
      kind: 'character',
      items: [
        item({ id: 'lib_1', kind: 'character', name: '林夏', tags: { gender: '女' } }),
        item({ id: 'lib_2', kind: 'character', name: '陆川', tags: { gender: '男' } }),
      ],
    })
    await screen.findByText('林夏')
    await user.click(screen.getByRole('combobox', { name: '性别' }))
    await user.click(await screen.findByRole('option', { name: '女' }))
    await waitFor(() => expect(screen.queryByText('陆川')).toBeNull())
    expect(screen.getByText('林夏')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重置筛选' }))
    expect(await screen.findByText('陆川')).toBeTruthy()
  })

  it('空库保留新建入口', async () => {
    await openPanel({ items: [] })
    expect(await screen.findByText('还没有道具')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '新建道具' }).length).toBeGreaterThan(0)
  })

  it('跨项目条目标出来源，同名项目也能区分', async () => {
    await openPanel({
      items: [
        item({ id: 'lib_1', name: '同名水杯', projectId: 'pj_1' }),
        item({ id: 'lib_2', name: '同名水杯', projectId: 'pj_2' }),
        item({ id: 'lib_3', name: '游离水杯' }),
      ],
      projects: [project('pj_1', '来源甲'), project('pj_2', '来源甲')],
    })
    const cards = await screen.findAllByRole('listitem')
    const labels = cards.map((card) => card.textContent ?? '')
    expect(labels.filter((text) => text.includes('来源甲'))).toHaveLength(2)
    expect(labels[0]).not.toBe(labels[1])
    expect(labels[2]).toContain('未归属项目')
  })

  it('项目改名后重新打开面板会刷新来源名称', async () => {
    let title = '旧项目名'
    mockFetch(async (request) => {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/api/library')
        return json([item({ id: 'lib_1', name: '跨项目道具', projectId: 'pj_1' })])
      if (request.method === 'GET' && url.pathname === '/api/projects')
        return json([project('pj_1', title)])
      return undefined
    })
    useLibrary.getState().setProject(null)
    renderApp(<LibraryPanel />)
    useLibrary.getState().show('prop')
    expect(await screen.findByText(/旧项目名/)).toBeTruthy()
    title = '新项目名'
    useLibrary.getState().show(null)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '资产库' })).toBeNull())
    useLibrary.getState().show('prop')
    expect(await screen.findByText(/新项目名/)).toBeTruthy()
    expect(screen.queryByText(/旧项目名/)).toBeNull()
  })

  it('来源项目读取失败时可重试，恢复后显示真实项目名', async () => {
    let broken = true
    mockFetch(async (request) => {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === '/api/library') return json([])
      if (request.method === 'GET' && url.pathname === '/api/projects')
        return broken
          ? json({ message: '项目列表暂不可用' }, 503)
          : json([project('pj_1', '来源甲')])
      return undefined
    })
    useLibrary.getState().setProject(null)
    const view = renderApp(<LibraryPanel />)
    useLibrary.getState().show('prop')
    expect(await screen.findByText('来源项目读取失败，可重试更新名称。')).toBeTruthy()
    broken = false
    await view.user.click(screen.getByRole('button', { name: '重试来源项目' }))
    await waitFor(() => expect(screen.queryByText('来源项目读取失败，可重试更新名称。')).toBeNull())
  })
})

describe('资产库面板的收藏', () => {
  it('收藏等待期间防止重复提交，失败可见且可重试', async () => {
    let failed = true
    let updates = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user } = await openPanel({
      items: [item({ id: 'lib_1', name: '收藏恢复水杯' })],
      handler: async (request) => {
        if (request.method !== 'PATCH') return undefined
        updates++
        if (updates === 1) await held
        const body = (await request.clone().json()) as Partial<LibraryItem>
        if (failed) return json({ error: 'test_failure', message: '收藏暂不可用' }, 503)
        return json({ ...item({ id: 'lib_1', name: '收藏恢复水杯' }), ...body })
      },
    })
    const card = (await screen.findAllByRole('listitem'))[0]!
    const star = within(card).getByRole('button', { name: '收藏' })
    await user.dblClick(star)
    await waitFor(() => expect(updates).toBe(1))
    expect((star as HTMLButtonElement).disabled).toBe(true)
    expect(star.getAttribute('aria-busy')).toBe('true')
    release()
    await waitFor(() =>
      expect(within(card).getByRole('alert').textContent).toContain('收藏暂不可用'),
    )
    // 失败要说清下一步
    expect(within(card).getByRole('alert').textContent).toContain('点击星标重试')
    expect((star as HTMLButtonElement).disabled).toBe(false)
    expect(star.getAttribute('aria-pressed')).toBe('false')
    failed = false
    await user.click(star)
    await waitFor(() =>
      expect(
        within(card).getByRole('button', { name: '取消收藏' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    )
    expect(within(card).queryByRole('alert')).toBeNull()
    expect(updates).toBe(2)
  })

  it('收藏响应延迟时仍可进入编辑，保存排队完成后名称与收藏均正确', async () => {
    const target = item({ id: 'lib_1', name: '并发修改前名称' })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const requests: string[] = []
    const { user } = await openPanel({
      items: [target],
      handler: async (request) => {
        if (request.method !== 'PATCH') return undefined
        const body = (await request.clone().json()) as Partial<LibraryItem>
        requests.push('favorite' in body ? 'favorite' : 'name')
        if (requests[0] === 'favorite') await held
        return json({ ...target, ...body, favorite: true })
      },
    })
    const card = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(card).getByRole('button', { name: '收藏' }))
    await waitFor(() => expect(requests).toEqual(['favorite']))
    await user.click(within(card).getAllByRole('button')[0]!)
    const name = (await screen.findByRole('textbox', {
      name: '名称',
    })) as HTMLInputElement
    await user.clear(name)
    await user.type(name, '并发修改后的名称')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('status').textContent).toContain('正在处理')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    release()
    await waitFor(() => expect(requests).toEqual(['favorite', 'name']))
    await user.click(screen.getByRole('button', { name: '返回' }))
    const renamed = await screen.findByRole('listitem')
    expect(renamed.textContent).toContain('并发修改后的名称')
    expect(
      within(renamed).getByRole('button', { name: '取消收藏' }).getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('取消收藏等待期间主动搜索，迟到响应不夺走查询框焦点', async () => {
    const target = item({ id: 'lib_1', name: '焦点测试一', favorite: true })
    const other = item({ id: 'lib_2', name: '焦点测试二', favorite: true })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user } = await openPanel({
      items: [target, other],
      handler: async (request) => {
        if (request.method !== 'PATCH') return undefined
        await held
        const body = (await request.clone().json()) as Partial<LibraryItem>
        return json({ ...target, ...body })
      },
    })
    const card = (await screen.findAllByRole('listitem'))[0]!
    const star = within(card).getByRole('button', { name: '取消收藏' })
    await user.click(star)
    const search = screen.getByRole('searchbox', { name: '搜索道具' })
    await user.click(search)
    await user.type(search, '焦点测试二')
    release()
    await waitFor(() =>
      expect(useLibrary.getState().items.find((entry) => entry.id === 'lib_1')?.favorite).toBe(
        false,
      ),
    )
    expect(document.activeElement).toBe(search)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('收藏列表取消当前卡片后聚焦下一项，最后一项消失后聚焦查询框', async () => {
    const items = [
      item({ id: 'lib_1', name: '焦点测试一', favorite: true }),
      item({ id: 'lib_2', name: '焦点测试二', favorite: true }),
    ]
    const { user } = await openPanel({
      items,
      handler: async (request) => {
        if (request.method !== 'PATCH') return undefined
        const id = new URL(request.url).pathname.split('/').pop()!
        const body = (await request.clone().json()) as Partial<LibraryItem>
        return json({ ...items.find((entry) => entry.id === id), ...body })
      },
    })
    await user.click(screen.getByRole('button', { name: '收藏' }))
    const search = screen.getByRole('searchbox', { name: '搜索道具' })
    const first = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(first).getByRole('button', { name: '取消收藏' }))
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1))
    await waitFor(() => expect(document.activeElement).not.toBe(search))
    const remaining = screen.getAllByRole('listitem')[0]!
    await user.click(within(remaining).getByRole('button', { name: '取消收藏' }))
    await waitFor(() => expect(screen.queryAllByRole('listitem')).toHaveLength(0))
    await waitFor(() => expect(document.activeElement).toBe(search))
  })
})

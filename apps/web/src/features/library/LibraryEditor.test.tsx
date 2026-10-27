// @vitest-environment happy-dom
import type { LibraryItem } from '@plein/protocol'
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

interface Route {
  method: string
  path: string
}

type Handler = (request: Request) => Response | undefined | Promise<Response | undefined>

/** 打开资产库面板；写操作交给用例自己的处理函数，读操作按列表和项目列表回应。 */
async function openEditor(
  items: LibraryItem[],
  options: { kind?: LibraryItem['kind']; projectId?: string | null; handler?: Handler } = {},
) {
  const routes: Route[] = []
  // 服务端语义：PATCH 只改传入的字段，创建后同一条目继续可改
  const saved = new Map(items.map((entry) => [entry.id, { ...entry }]))
  let created = 0
  mockFetch(async (request) => {
    const url = new URL(request.url)
    routes.push({ method: request.method, path: url.pathname })
    const handled = await options.handler?.(request)
    if (handled) return handled
    if (request.method === 'GET' && url.pathname === '/api/library')
      return json([...saved.values()])
    if (request.method === 'GET' && url.pathname === '/api/projects') return json([])
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
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    if (request.method === 'POST') {
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as Partial<LibraryItem>
      const next = item({ ...body, id: `lib_new_${++created}`, name: body.name ?? '' })
      saved.set(next.id, next)
      return json(next, 201)
    }
    return undefined
  })
  useLibrary.getState().setProject(options.projectId ?? null)
  const view = renderApp(<LibraryPanel />)
  useLibrary.getState().show(options.kind ?? 'prop')
  await screen.findByRole('dialog', { name: '资产库' })
  return { ...view, routes }
}

const bodyOf = async (request: Request) =>
  (await request
    .clone()
    .json()
    .catch(() => undefined)) as { name?: string } | undefined

describe('资产库条目编辑', () => {
  it('参考图达到上限时提示先移除部分图片', async () => {
    const images = Array.from({ length: 24 }, (_, index) => ({
      slot: 'main' as const,
      assetId: String(index).padStart(64, '0'),
    }))
    const { user } = await openEditor([item({ id: 'lib_1', name: '参考图道具', images })])
    const card = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(card).getAllByRole('button')[0]!)
    expect(await screen.findByText('已达到 24 张参考图上限，请先移除部分图片。')).toBeTruthy()
  })

  it('从画布上的角色卡打开档案时直达对应页签', async () => {
    const character = item({ id: 'lib_1', kind: 'character', name: '林夏' })
    await openEditor([character], { kind: 'character' })
    await screen.findByText('林夏')
    // 画布上的「编辑档案」带着目标和页签打开面板
    useLibrary.getState().edit(character, 'periods')
    const tab = await screen.findByRole('button', { name: '时期与服饰' })
    await waitFor(() => expect(tab.getAttribute('aria-pressed')).toBe('true'))
    expect((await screen.findByRole('textbox', { name: '名称' })) as HTMLInputElement).toBeTruthy()
  })

  it('删除等待期间锁定编辑操作，失败后保留内容并可重试', async () => {
    const target = item({ id: 'lib_1', name: '删除恢复道具' })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let failed = true
    const { user, routes } = await openEditor([target], {
      handler: async (request) => {
        if (request.method !== 'DELETE') return undefined
        await held
        if (failed) return json({ error: 'test_failure', message: '删除暂不可用' }, 503)
        return new Response(null, { status: 204 })
      },
    })
    const card = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(card).getAllByRole('button')[0]!)
    const remove = (await screen.findByRole('button', {
      name: '删除',
    })) as HTMLButtonElement
    await user.click(remove)
    const confirm = await screen.findByRole('dialog', { name: '删除道具「删除恢复道具」？' })
    await user.click(within(confirm).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(routes.some((r) => r.method === 'DELETE')).toBe(true))
    expect(remove.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '返回' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('正在处理')
    // 删除期间设定输入锁定，避免继续输入后被一起丢掉
    expect(
      (screen.getByRole('group', { name: '资产设定编辑' }) as HTMLFieldSetElement).disabled,
    ).toBe(true)
    release()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('删除失败：删除暂不可用'),
    )
    expect(screen.getByRole('alert').textContent).toContain('请稍后重试')
    expect(
      (screen.getByRole('group', { name: '资产设定编辑' }) as HTMLFieldSetElement).disabled,
    ).toBe(false)
    expect((screen.getByRole('textbox', { name: '名称' }) as HTMLInputElement).value).toBe(
      '删除恢复道具',
    )
    expect(remove.disabled).toBe(false)
    failed = false
    await user.click(remove)
    const second = await screen.findByRole('dialog', { name: '删除道具「删除恢复道具」？' })
    await user.click(within(second).getByRole('button', { name: '取消' }))
    expect(routes.filter((r) => r.method === 'DELETE')).toHaveLength(1)
  })

  it('保存等待时继续编辑不丢掉新草稿，下一次保存提交最新名称', async () => {
    const target = item({ id: 'lib_1', name: '名称基线' })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const patches: Array<string | undefined> = []
    const { user, routes } = await openEditor([target], {
      handler: async (request) => {
        if (request.method !== 'PATCH') return undefined
        const body = await bodyOf(request)
        patches.push(body?.name)
        if (patches.length === 1) await held
        return json({ ...target, name: body?.name })
      },
    })
    const card = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(card).getAllByRole('button')[0]!)
    const name = (await screen.findByRole('textbox', {
      name: '名称',
    })) as HTMLInputElement
    await user.clear(name)
    await user.type(name, '第一次名称')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(screen.getByRole('status').textContent).toContain('正在处理')
    await user.clear(name)
    await user.type(name, '保留的新名称')
    release()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('已保存提交时的内容，仍有新修改'),
    )
    expect(name.value).toBe('保留的新名称')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches[1]).toBe('保留的新名称')
    expect(routes.filter((r) => r.method === 'PATCH')).toHaveLength(2)
  })

  it('关闭后重开同条目继续保存，旧应答不覆盖新草稿且写入按提交顺序完成', async () => {
    const target = item({ id: 'lib_1', name: '跨会话保存基线' })
    const submitted: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, routes } = await openEditor([target], {
      handler: async (request) => {
        if (request.method !== 'PATCH') return undefined
        const body = await bodyOf(request)
        submitted.push(body?.name ?? '')
        if (submitted.length === 1) await held
        return json({ ...target, name: body?.name })
      },
    })
    const card = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(card).getAllByRole('button')[0]!)
    const name = (await screen.findByRole('textbox', {
      name: '名称',
    })) as HTMLInputElement
    await user.clear(name)
    await user.type(name, '旧会话已提交')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(submitted).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull())
    // 重新打开面板，继续编辑同一条
    useLibrary.getState().show('prop')
    const reopened = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(reopened).getAllByRole('button')[0]!)
    const again = (await screen.findByRole('textbox', {
      name: '名称',
    })) as HTMLInputElement
    await user.clear(again)
    await user.type(again, '新会话已提交')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted).toEqual(['旧会话已提交'])
    await user.clear(again)
    await user.type(again, '新会话尚未提交')
    release()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('已保存提交时的内容，仍有新修改'),
    )
    expect(again.value).toBe('新会话尚未提交')
    expect(submitted).toEqual(['旧会话已提交', '新会话已提交'])
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(submitted).toHaveLength(3))
    expect(submitted[2]).toBe('新会话尚未提交')
    expect(routes.filter((r) => r.method === 'PATCH')).toHaveLength(3)
  })

  it('官方复制等待时阻止重复提交，切换到其他条目后迟到结果不抢走编辑目标', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, routes } = await openEditor([], {
      kind: 'style',
      handler: async (request) => {
        if (request.method !== 'POST') return undefined
        await held
        return json(item({ id: 'lib_copy', name: '官方复制' }), 201)
      },
    })
    const official = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(official).getAllByRole('button')[0]!)
    await screen.findByRole('textbox', { name: '名称' })
    const copy = screen.getByRole('button', {
      name: '复制到我的',
    }) as HTMLButtonElement
    await user.dblClick(copy)
    await waitFor(() => expect(routes.filter((r) => r.method === 'POST')).toHaveLength(1))
    expect(copy.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('正在处理')
    // 切到别的类别：迟到的复制结果不该抢走新的编辑目标
    useLibrary.getState().show('prop')
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull())
    expect(routes.filter((r) => r.method === 'POST')).toHaveLength(1)
    release()
  })

  it('新建等待时继续编辑，响应后保留新内容并更新同一条资产', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const posts: string[] = []
    const patches: string[] = []
    const { user } = await openEditor([], {
      handler: async (request) => {
        if (request.method === 'POST') {
          const body = await bodyOf(request)
          posts.push(body?.name ?? '')
          await held
          return json(item({ id: 'lib_new', name: body?.name ?? '' }), 201)
        }
        if (request.method === 'PATCH') {
          const body = await bodyOf(request)
          patches.push(body?.name ?? '')
          return json(item({ id: 'lib_new', name: body?.name ?? '' }))
        }
        return undefined
      },
    })
    await user.click(screen.getAllByRole('button', { name: '新建道具' })[0]!)
    const name = (await screen.findByRole('textbox', {
      name: '名称',
    })) as HTMLInputElement
    const description = (await screen.findByRole('textbox', {
      name: /^设定/,
    })) as HTMLTextAreaElement
    await user.clear(name)
    await user.type(name, '提交时的水杯')
    await user.clear(description)
    await user.type(description, '提交时的设定')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(posts).toEqual(['提交时的水杯']))
    await user.clear(name)
    await user.type(name, '继续编辑后的水杯')
    release()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('已保存提交时的内容，仍有新修改'),
    )
    expect(name.value).toBe('继续编辑后的水杯')
    expect(description.value).toBe('提交时的设定')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(patches).toEqual(['继续编辑后的水杯']))
    // 只创建一次，之后都是更新同一条资产
    expect(posts).toHaveLength(1)
  })

  it('官方复制完成后可以直接编辑保存，更新复制出来的条目而不再次创建', async () => {
    const { user, routes } = await openEditor([], { kind: 'style' })
    const official = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(official).getAllByRole('button')[0]!)
    await screen.findByRole('textbox', { name: '名称' })
    await user.click(screen.getByRole('button', { name: '复制到我的' }))
    await waitFor(() => expect(routes.filter((r) => r.method === 'POST')).toHaveLength(1))
    // 复制完成后就是自己的一条资产，可以直接改名保存
    const name = (await screen.findByRole('textbox', {
      name: '名称',
    })) as HTMLInputElement
    expect((name as HTMLInputElement).readOnly).toBe(false)
    await user.clear(name)
    await user.type(name, '复制后编辑的风格')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(routes.filter((r) => r.method === 'PATCH')).toHaveLength(1))
    expect(routes.filter((r) => r.method === 'POST')).toHaveLength(1)
  })

  it('解除归属的保存等待期间重新勾选来源，不会静默改成当前项目', async () => {
    const target = item({ id: 'lib_1', name: '跨项目道具', projectId: 'pj_other' })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const bodies: Array<{ projectId?: string | null }> = []
    const { user } = await openEditor([target], {
      projectId: 'pj_current',
      handler: async (request) => {
        if (request.method !== 'PATCH') return undefined
        const body = await bodyOf(request)
        bodies.push(body as { projectId?: string | null })
        if (bodies.length === 1) await held
        return json({ ...target, ...body })
      },
    })
    const scope = within(screen.getByRole('group', { name: '范围' }))
    await user.click(scope.getByRole('button', { name: '全部' }))
    const card = (await screen.findAllByRole('listitem'))[0]!
    await user.click(within(card).getAllByRole('button')[0]!)
    const keep = await screen.findByRole('checkbox', { name: /保留在来源项目/ })
    expect((keep as HTMLInputElement).checked).toBe(true)
    await user.click(keep)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]?.projectId).toBeNull()
    // 保存等待期间重新勾选来源
    await user.click(keep)
    release()
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('已保存提交时的内容，仍有新修改'),
    )
    expect((keep as HTMLInputElement).checked).toBe(true)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]?.projectId).toBe('pj_other')
  })

  it('新建失败保留草稿，修正后重试只创建一条资产', async () => {
    let failed = true
    const created: string[] = []
    const { user, routes } = await openEditor([], {
      handler: async (request) => {
        if (request.method !== 'POST') return undefined
        const body = await bodyOf(request)
        if (failed) return json({ error: 'test_failure', message: '新建暂不可用' }, 503)
        created.push(body?.name ?? '')
        return json(item({ id: 'lib_new', name: body?.name ?? '' }), 201)
      },
    })
    await user.click(screen.getAllByRole('button', { name: '新建道具' })[0]!)
    const name = (await screen.findByRole('textbox', {
      name: '名称',
    })) as HTMLInputElement
    await user.clear(name)
    await user.type(name, '新资产')
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('保存失败：新建暂不可用'),
    )
    expect(name.value).toBe('新资产')
    failed = false
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(created).toEqual(['新资产']))
    expect(routes.filter((r) => r.method === 'POST')).toHaveLength(2)
    expect(useLibrary.getState().items).toHaveLength(1)
  })
})

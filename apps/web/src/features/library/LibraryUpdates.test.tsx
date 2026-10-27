// @vitest-environment happy-dom
import type { LibraryItem, LibraryUpdates } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { renderApp, screen, waitFor } from '../../testing/render'
import { LibraryUpdatesPanel } from './LibraryUpdates'

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

const updates = (over: Partial<LibraryUpdates> = {}): LibraryUpdates => ({
  revision: 'rev_1',
  cards: [
    {
      canvasId: 'cv_1',
      canvasTitle: '第一集',
      nodeId: 'n_1',
      name: '旧打火机',
      expected: 'exp_1',
      pinned: false,
      revision: null,
      changes: [
        { field: 'description', before: '旧设定', after: '新设定' },
        { field: 'name', before: '旧打火机', after: '新打火机' },
      ],
    },
  ],
  ...over,
})

type Handler = (request: Request) => Response | undefined | Promise<Response | undefined>

/** 渲染差异面板；读差异和同步的请求都由用例自己回应。 */
async function renderPanel(target: LibraryItem, handler: Handler) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  mockFetch(async (request) => {
    const url = new URL(request.url)
    calls.push({
      method: request.method,
      path: url.pathname,
      body:
        request.method === 'GET'
          ? undefined
          : await request
              .clone()
              .json()
              .catch(() => undefined),
    })
    return handler(request)
  })
  const view = renderApp(<LibraryUpdatesPanel item={target} />)
  return { ...view, calls }
}

describe('跨画布资产更新面板', () => {
  it('读取差异期间不允许提交旧快照，读取成功后按默认选择同步', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user } = await renderPanel(item({ id: 'lib_1', name: '旧打火机' }), async (request) => {
      if (request.method === 'GET') {
        await held
        return json(updates())
      }
      return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
    })
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    expect(await screen.findByText('正在读取差异…')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: '同步选中的字段' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    // 读取期间字段选择也不可用，避免提交旧快照
    expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    release()
    await screen.findByText('第一集 · 旧打火机')
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(2)
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true)
    expect(
      (screen.getByRole('button', { name: '同步选中的字段' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('刷新差异期间不允许提交旧快照，刷新完成后恢复可提交', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reads = 0
    const { user } = await renderPanel(item({ id: 'lib_1', name: '旧打火机' }), async (request) => {
      if (request.method === 'GET') {
        reads++
        if (reads > 1) await held
        return json(updates())
      }
      return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
    })
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    await screen.findByText('第一集 · 旧打火机')
    await user.click(screen.getByRole('button', { name: '刷新差异' }))
    expect(await screen.findByText('正在读取差异…')).toBeTruthy()
    // 刷新期间整个提交区被锁住，不会把旧快照提交出去
    expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    release()
    await waitFor(() =>
      expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false),
    )
  })

  it('读取失败给出可重试提示，恢复前不允许同步', async () => {
    let failed = true
    const { user } = await renderPanel(item({ id: 'lib_1', name: '旧打火机' }), async (request) => {
      if (request.method === 'GET')
        return failed ? json({ message: '差异暂不可读' }, 503) : json(updates())
      return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
    })
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('差异暂不可读'))
    expect(screen.getByRole('alert').textContent).toContain('请刷新差异后重试')
    expect(
      (screen.getByRole('button', { name: '同步选中的字段' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    failed = false
    await user.click(screen.getByRole('button', { name: '刷新差异' }))
    await screen.findByText('第一集 · 旧打火机')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      (screen.getByRole('button', { name: '同步选中的字段' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('同步成功后说明结果，失败时提示刷新差异后重试', async () => {
    let failed = true
    const { user, calls } = await renderPanel(
      item({ id: 'lib_1', name: '旧打火机' }),
      async (request) => {
        if (request.method === 'GET') return json(updates())
        if (failed) return json({ message: '同步暂不可用' }, 503)
        return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
      },
    )
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    await screen.findByText('第一集 · 旧打火机')
    await user.click(screen.getByRole('button', { name: '同步选中的字段' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('同步暂不可用'))
    // 失败后要先刷新差异，才能重新提交：整个字段区被禁用
    expect((document.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    failed = false
    await user.click(screen.getByRole('button', { name: '刷新差异' }))
    await screen.findByText('第一集 · 旧打火机')
    await user.click(screen.getByRole('button', { name: '同步选中的字段' }))
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('选中的卡片已同步'),
    )
    const apply = calls.find((call) => call.method === 'POST')
    expect(apply?.body).toMatchObject({
      revision: 'rev_1',
      targets: [
        {
          canvasId: 'cv_1',
          nodeId: 'n_1',
          expected: 'exp_1',
          mode: 'update',
          fields: ['description', 'name'],
        },
      ],
    })
  })

  it('只提交勾选的字段，固定与解除固定保留当前版本', async () => {
    const { user, calls } = await renderPanel(
      item({ id: 'lib_1', name: '旧打火机' }),
      async (request) => {
        if (request.method === 'GET') return json(updates())
        return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
      },
    )
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    await screen.findByText('第一集 · 旧打火机')
    await user.click(screen.getByRole('checkbox', { name: '名称' }))
    await user.click(screen.getByRole('button', { name: '同步选中的字段' }))
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
        targets: [{ fields: ['description'] }],
      }),
    )
  })

  it('固定的卡片保留当前版本，字段不可勾选但可以解除固定', async () => {
    const { user, calls } = await renderPanel(
      item({ id: 'lib_1', name: '旧打火机' }),
      async (request) => {
        if (request.method === 'GET')
          return json(updates({ cards: [{ ...updates().cards[0]!, pinned: true }] }))
        return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
      },
    )
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    await screen.findByText('第一集 · 旧打火机 · 已固定')
    const checkbox = screen.getAllByRole('checkbox')[0] as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    expect(checkbox.disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: '解除固定' }))
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
        targets: [{ mode: 'unpin' }],
      }),
    )
  })

  it('同步等待时切换编辑目标，迟到结果不通知也不改动新面板', async () => {
    const target = item({ id: 'lib_1', name: '旧打火机' })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, rerender } = await renderPanel(target, async (request) => {
      if (request.method === 'GET') return json(updates())
      await held
      return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
    })
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    await screen.findByText('第一集 · 旧打火机')
    await user.click(screen.getByRole('button', { name: '同步选中的字段' }))
    rerender(<LibraryUpdatesPanel item={item({ id: 'lib_2', name: '另一件资产' })} />)
    release()
    await waitFor(() => expect(screen.queryByText('已同步')).toBeNull())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('切换编辑目标后迟到的差异响应不写回新面板', async () => {
    const target = item({ id: 'lib_1', name: '旧打火机' })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const { user, rerender } = await renderPanel(target, async (request) => {
      if (request.method === 'GET') {
        const id = new URL(request.url).pathname.split('/').at(-2)
        if (id === 'lib_1') {
          await held
          return json(updates())
        }
        return json(
          updates({
            cards: [{ ...updates().cards[0]!, canvasTitle: '第二集', name: '另一件资产' }],
          }),
        )
      }
      return json({ updated: 1, persistence: 'saved', pendingCanvases: [] })
    })
    await user.click(screen.getByRole('button', { name: '查看画布中的版本' }))
    await screen.findByText('正在读取差异…')
    rerender(<LibraryUpdatesPanel item={item({ id: 'lib_2', name: '另一件资产' })} />)
    await screen.findByText('第二集 · 另一件资产')
    release()
    // 旧条目的迟到响应不该把上一条资产的差异写回当前面板
    await waitFor(() => expect(screen.queryByText('第一集 · 旧打火机')).toBeNull())
    expect(screen.getByText('第二集 · 另一件资产')).toBeTruthy()
  })
})

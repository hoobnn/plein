// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc } from '@plein/doc'
import type { CanvasCheckpoint, CheckpointDetail } from '@plein/protocol'
import { expect, it, onTestFinished, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { useCanvas } from '../../stores/canvas'
import { CheckpointsPanel } from './Checkpoints'
import { useCheckpoints } from './store'

// 独立 GPU 预览的生命周期另测；这里保留真实面板、API client、store 与弹窗。
vi.mock('./CheckpointPreview', () => ({
  CheckpointPreview: ({ state }: { state: string }) => <div data-testid="preview">{state}</div>,
}))
resetStoreAfterEach(useCheckpoints)
const cp = (id: string): CanvasCheckpoint => ({
  id,
  projectId: 'p',
  sourceCanvasId: 'c',
  sourceCanvasTitle: '画布',
  name: `版本 ${id}`,
  createdAt: 1,
  assets: 0,
  missingAssets: [],
})
const a = cp('a'),
  b = cp('b'),
  c = cp('c')
const list = (items = [a, b], nextCursor: string | null = null) =>
  Response.json({ items, nextCursor })
const detail = (item: CanvasCheckpoint) =>
  Response.json({ ...item, state: `正文 ${item.id}` } satisfies CheckpointDetail)
const failure = (message: string) => Response.json({ message }, { status: 503 })
const deferred = () => {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const panel = () => screen.getByRole('dialog', { name: '创作检查点' })
const article = (item: CanvasCheckpoint) =>
  screen
    .getAllByRole('heading', { name: item.name })
    .find((heading) => heading.closest('article'))!
    .closest('article')!
const button = (name: string, item?: CanvasCheckpoint) =>
  within(item ? article(item) : panel()).getByRole('button', {
    name,
  }) as HTMLButtonElement

async function setup(
  handler?: (request: Request) => Response | undefined | Promise<Response | undefined>,
  page: () => Response | Promise<Response> = () => list(),
) {
  const doc = createDoc()
  onTestFinished(() => doc.destroy())
  useCanvas.setState({ canvasId: 'c', sync: 'connected', engine: { doc } as Engine })
  const fetch = mockFetch(async (request) => {
    const custom = await handler?.(request)
    if (custom) return custom
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/projects/p/checkpoints') return page()
    if (request.method === 'GET' && url.pathname.startsWith('/api/checkpoints/'))
      return detail(cp(url.pathname.split('/').at(-1)!))
  })
  useCheckpoints.getState().show({ projectId: 'p', canvasId: 'c' })
  const rendered = renderApp(<CheckpointsPanel />, { route: { name: 'canvas', id: 'c' } })
  await screen.findByRole('heading', { name: a.name })
  const preview = async (item = a) => {
    await rendered.user.click(button('只读预览', item))
    await screen.findByText(`正文 ${item.id}`)
  }
  const remove = async (item = a) => {
    await rendered.user.click(button(`删除检查点 ${item.name}`, item))
    const dialog = screen.getByRole('dialog', { name: `删除检查点「${item.name}」？` })
    await rendered.user.click(within(dialog).getByRole('button', { name: '删除检查点' }))
  }
  const reopen = async (projectId = 'p') => {
    await rendered.user.click(button('关闭'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '创作检查点' })).toBeNull())
    act(() => useCheckpoints.getState().show({ projectId, canvasId: 'c' }))
    await screen.findByRole('heading', { name: a.name })
  }
  return { ...rendered, fetch, preview, remove, reopen }
}

it('预览读取失败保留选择，重试等待禁止重复操作，成功显示当前版本', async () => {
  let reads = 0
  const held = deferred()
  const f = await setup((request) =>
    request.url.endsWith('/checkpoints/a')
      ? ++reads === 1
        ? failure('预览暂时不可用')
        : held.promise
      : undefined,
  )
  await f.user.click(button('只读预览', a))
  expect((await screen.findByRole('alert')).textContent).toContain('预览暂时不可用')
  await f.user.click(button('重新加载预览'))
  expect(button('重新加载预览').disabled).toBe(true)
  expect(button('只读预览', a).disabled).toBe(true)
  await act(async () => held.resolve(detail(a)))
  await screen.findByText('正文 a')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reads).toBe(2)
})

it('快速切换预览丢弃旧响应，关闭预览清除选择', async () => {
  const held = deferred()
  const f = await setup((request) =>
    request.url.endsWith('/checkpoints/a') ? held.promise : undefined,
  )
  await f.user.click(button('只读预览', a))
  await f.preview(b)
  await act(async () => held.resolve(detail(a)))
  expect(screen.queryByText('正文 a')).toBeNull()
  expect(screen.getByText('正文 b')).toBeTruthy()
  await f.user.click(button('关闭预览'))
  expect(screen.queryByTestId('preview')).toBeNull()
})

it.each([false, true])('删除等待%s重开时仍锁定目标，完成只移除目标且保留新选择', async (reopen) => {
  const held = deferred()
  let items = [a, b],
    writes = 0
  const f = await setup(
    (request) => {
      if (request.method === 'DELETE') {
        writes++
        return held.promise
      }
    },
    () => list(items),
  )
  await f.preview()
  await f.remove()
  if (reopen) await f.reopen()
  expect(button(`删除检查点 ${a.name}`, a).disabled).toBe(true)
  expect(screen.getByText(/正在删除检查点/)).toBeTruthy()
  await f.preview(b)
  items = [b]
  await act(async () => held.resolve(new Response(null, { status: 204 })))
  await waitFor(() => expect(screen.queryByRole('heading', { name: a.name })).toBeNull())
  expect(screen.getByText('正文 b')).toBeTruthy()
  expect(writes).toBe(1)
})

it('取消和 Escape 不删除；失败保留预览，显式重试成功才清除目标', async () => {
  let writes = 0,
    items = [a, b]
  const f = await setup(
    (request) => {
      if (request.method !== 'DELETE') return
      writes++
      if (writes === 1) return failure('删除暂时失败')
      items = [b]
      return new Response(null, { status: 204 })
    },
    () => list(items),
  )
  await f.preview()
  for (const cancel of ['button', 'escape']) {
    const target = button(`删除检查点 ${a.name}`, a)
    await f.user.click(target)
    if (cancel === 'button') await f.user.click(screen.getByRole('button', { name: '取消' }))
    else await f.user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: `删除检查点「${a.name}」？` })).toBeNull(),
    )
    expect(document.activeElement).toBe(target)
    expect(writes).toBe(0)
  }
  await f.remove()
  expect((await screen.findByRole('alert')).textContent).toContain('删除暂时失败')
  expect(screen.getByText('正文 a')).toBeTruthy()
  await f.remove()
  await waitFor(() => expect(screen.queryByRole('heading', { name: a.name })).toBeNull())
  expect(screen.queryByTestId('preview')).toBeNull()
  expect(writes).toBe(2)
})

it('删除成功后刷新失败仍保留其他版本，可刷新恢复而不重复删除', async () => {
  let removed = false,
    fail = true,
    writes = 0
  const f = await setup(
    (request) => {
      if (request.method === 'DELETE') {
        writes++
        removed = true
        return new Response(null, { status: 204 })
      }
    },
    () => (removed && fail ? failure('列表暂时失败') : list(removed ? [b] : [a, b])),
  )
  await f.preview(b)
  await f.remove()
  expect((await screen.findByRole('alert')).textContent).toContain('列表暂时失败')
  expect(screen.queryByRole('heading', { name: a.name })).toBeNull()
  expect(screen.getByText('正文 b')).toBeTruthy()
  fail = false
  await f.user.click(button('刷新'))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  expect(writes).toBe(1)
})

it('删除前发起的旧列表迟到不会复活已删除版本', async () => {
  const held = deferred()
  let reads = 0,
    removed = false
  const f = await setup(
    (request) => {
      if (request.method === 'DELETE') {
        removed = true
        return new Response(null, { status: 204 })
      }
    },
    () => (++reads === 2 ? held.promise : list(removed ? [b] : [a, b])),
  )
  await f.user.click(button('刷新'))
  await f.remove()
  await waitFor(() => expect(screen.queryByRole('heading', { name: a.name })).toBeNull())
  await act(async () => held.resolve(list()))
  expect(screen.queryByRole('heading', { name: a.name })).toBeNull()
})

it('分页失败保留条目和预览，重试锁定按钮、去重并清除错误', async () => {
  let reads = 0
  const held = deferred()
  const f = await setup(
    (request) => {
      if (new URL(request.url).searchParams.has('cursor'))
        return ++reads === 1 ? failure('下一页暂时失败') : held.promise
    },
    () => list([a, b], 'next'),
  )
  await f.preview(b)
  await f.user.click(button('加载更多检查点'))
  await screen.findByRole('alert')
  expect(screen.getAllByRole('article')).toHaveLength(2)
  expect(screen.getByText('正文 b')).toBeTruthy()
  await f.user.click(button('加载更多检查点'))
  expect(button('正在加载更多…').disabled).toBe(true)
  await act(async () => held.resolve(list([b, c])))
  await screen.findByRole('heading', { name: c.name })
  expect(screen.getAllByRole('article')).toHaveLength(3)
  expect(screen.queryByRole('alert')).toBeNull()
  expect(reads).toBe(2)
})

it.each(['save', 'delete', 'reopen'] as const)(
  '分页等待期间%s，旧分页结果或错误不污染刷新后的列表',
  async (action) => {
    const held = deferred(),
      refreshed = deferred()
    let pageReads = 0,
      changed = false
    const f = await setup(
      (request) => {
        const url = new URL(request.url)
        if (url.searchParams.has('cursor')) return ++pageReads === 1 ? held.promise : list([c])
        if (request.method === 'POST') {
          changed = true
          return Response.json(c)
        }
        if (request.method === 'DELETE') {
          changed = true
          return new Response(null, { status: 204 })
        }
        if (changed && url.pathname === '/api/projects/p/checkpoints') return refreshed.promise
      },
      () => list([a, b], 'next'),
    )
    await f.user.click(button('加载更多检查点'))
    if (action === 'save') {
      await f.user.type(screen.getByRole('textbox', { name: '检查点名称' }), '新版本')
      await f.user.click(button('保存当前画布'))
    } else if (action === 'delete') await f.remove(b)
    else await f.reopen()
    await act(async () => held.resolve(action === 'delete' ? failure('旧分页失败') : list([c])))
    if (action !== 'reopen') {
      expect(button('刷新').disabled).toBe(true)
      expect(screen.queryByRole('alert')).toBeNull()
      await act(async () => refreshed.resolve(list(action === 'save' ? [c, a] : [a], 'fresh')))
    }
    await waitFor(() => expect(button('刷新').disabled).toBe(false))
    expect(screen.getAllByRole('article')).toHaveLength(action === 'delete' ? 1 : 2)
    if (action === 'reopen') {
      await f.user.click(button('加载更多检查点'))
      await screen.findByRole('heading', { name: c.name })
      expect(pageReads).toBe(2)
    }
  },
)

it('同帧重复恢复只发送一次请求，失败释放门闩后可重试', async () => {
  const held = deferred()
  let writes = 0
  const f = await setup((request) => {
    if (request.method === 'POST') {
      writes++
      return writes === 1 ? held.promise : Response.json({ canvasId: 'restored' })
    }
  })
  const restore = button('恢复为新画布', a)
  act(() => {
    restore.click()
    restore.click()
  })
  await waitFor(() => expect(writes).toBe(1))
  expect(button('恢复中…', a).disabled).toBe(true)
  await act(async () => held.resolve(failure('恢复暂时不可用')))
  expect(screen.getByRole('alert').textContent).toContain('恢复暂时不可用')
  await f.user.click(button('恢复为新画布', a))
  await waitFor(() => expect(location.hash).toBe('#/c/restored'))
  expect(writes).toBe(2)
})

it.each(['success', 'failure'] as const)(
  '关闭并重开后旧恢复%s不导航或污染新窗口，重开期间禁止重复恢复',
  async (outcome) => {
    const held = deferred()
    let writes = 0
    const f = await setup((request) => {
      if (request.method === 'POST') {
        writes++
        return held.promise
      }
    })
    await f.user.click(button('恢复为新画布', a))
    expect(button('恢复中…', a).disabled).toBe(true)
    await f.reopen()
    expect(button('恢复中…', a).disabled).toBe(true)
    await f.user.click(button('恢复中…', a))
    expect(screen.getByText(/正在恢复为新画布/)).toBeTruthy()
    await act(async () =>
      held.resolve(
        outcome === 'success' ? Response.json({ canvasId: 'restored' }) : failure('旧窗口失败'),
      ),
    )
    await waitFor(() => expect(button('恢复为新画布', a).disabled).toBe(false))
    expect(location.hash).toBe('#/c/c')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(writes).toBe(1)
  },
)

it.each(['success', 'failure'] as const)(
  '切换项目后旧恢复%s不关闭新窗口或覆盖当前画布',
  async (outcome) => {
    const held = deferred()
    const f = await setup((request) => {
      if (request.method === 'POST') return held.promise
      if (new URL(request.url).pathname === '/api/projects/other/checkpoints') return list()
    })
    await f.user.click(button('恢复为新画布', a))
    act(() => useCanvas.setState({ canvasId: 'other' }))
    await f.reopen('other')
    await act(async () =>
      held.resolve(
        outcome === 'success' ? Response.json({ canvasId: 'restored' }) : failure('旧项目失败'),
      ),
    )
    expect(panel()).toBeTruthy()
    expect(useCanvas.getState().canvasId).toBe('other')
    expect(location.hash).toBe('#/c/c')
    expect(screen.queryByRole('alert')).toBeNull()
  },
)

it('当前恢复失败允许重试，成功关闭窗口并导航新画布', async () => {
  let writes = 0
  const f = await setup((request) => {
    if (request.method === 'POST')
      return ++writes === 1 ? failure('恢复暂时不可用') : Response.json({ canvasId: 'restored' })
  })
  await f.user.click(button('恢复为新画布', a))
  expect((await screen.findByRole('alert')).textContent).toContain('恢复暂时不可用')
  expect(button('恢复为新画布', a).disabled).toBe(false)
  await f.user.click(button('恢复为新画布', a))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '创作检查点' })).toBeNull())
  expect(location.hash).toBe('#/c/restored')
  expect(writes).toBe(2)
})

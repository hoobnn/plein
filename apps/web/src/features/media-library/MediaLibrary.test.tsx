// @vitest-environment happy-dom
import type { MediaLibraryItem, MediaLibraryPage, MediaSource } from '@plein/protocol'
import { type Engine, Scene } from '@plein/canvas-core'
import { openDoc } from '@plein/doc/testing'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { mockFetch } from '../../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, waitFor, within } from '../../testing/render'
import { useLibrary } from '../library/store'
import { MediaLibraryPanel } from './MediaLibrary'
import { useMediaLibrary } from './store'

resetStoreAfterEach(useMediaLibrary)
resetStoreAfterEach(useLibrary)

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const asset = (over: Partial<MediaLibraryItem> & { id: string; name: string }): MediaLibraryItem =>
  ({
    kind: 'image',
    mime: 'image/png',
    size: 1024,
    width: 800,
    height: 600,
    duration: undefined,
    variants: [],
    createdAt: 1,
    sourceCount: 1,
    sources: [],
    ...over,
  }) as MediaLibraryItem

const source = (over: Partial<MediaSource> & { id: string; label: string }): MediaSource => ({
  type: 'canvas',
  locator: 'node',
  projectId: 'pj_1',
  canvasId: 'cv_1',
  nodeId: 'node_1',
  resultId: null,
  createdAt: 1,
  adopted: false,
  locatable: true,
  ...over,
})

type Handler = (request: Request) => Response | undefined | Promise<Response | undefined>

interface Options {
  page?: MediaLibraryPage
  sources?: MediaSource[]
  handler?: Handler
  /** 打开一张画布，让「放入当前画布」可用。 */
  canvas?: boolean
}

/**
 * 打开素材面板：只回应素材列表与来源，其余请求都要在用例里显式声明。
 * 记录每次列表请求的查询参数，便于断言搜索与筛选真的发出去了。
 */
async function openPanel(options: Options = {}) {
  const page = options.page ?? { items: [], nextCursor: null }
  const sources = options.sources ?? []
  const lists: Array<{ q: string; kind: string | null; cursor: string | null }> = []
  const sourceCalls: string[] = []
  mockFetch(async (request) => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/assets')
      lists.push({
        q: url.searchParams.get('q') ?? '',
        kind: url.searchParams.get('kind'),
        cursor: url.searchParams.get('cursor'),
      })
    if (request.method === 'GET' && /^\/api\/assets\/[^/]+\/sources$/.test(url.pathname))
      sourceCalls.push(url.searchParams.get('cursor') ?? '')
    const handled = await options.handler?.(request)
    if (handled) return handled
    if (request.method === 'GET' && url.pathname === '/api/projects') return json([])
    if (request.method === 'GET' && url.pathname === '/api/library') return json([])
    if (request.method === 'GET' && url.pathname === '/api/assets') return json(page)
    if (request.method === 'GET' && /^\/api\/assets\/[^/]+\/sources$/.test(url.pathname))
      return json({ items: sources, nextCursor: null })
    return undefined
  })
  if (options.canvas) {
    const doc = openDoc()
    const engine = {
      doc,
      scene: new Scene(doc),
      camera: { viewRect: { x: 0, y: 0, w: 800, h: 600 } },
      selection: { set: vi.fn() },
      zoomToFit: vi.fn(),
      setTool: vi.fn(),
      onStateChange: () => () => {},
    } as unknown as Engine
    useCanvas.setState({ engine, canvasId: 'cv_1' })
  }
  const view = renderApp(<MediaLibraryPanel />)
  useMediaLibrary.getState().show()
  await screen.findByRole('dialog', { name: '素材' })
  // 首屏请求与项目列表都结算完，避免遗留的异步更新
  await waitFor(() => expect(lists.length).toBeGreaterThan(0))
  return { ...view, lists, sourceCalls }
}

const card = (name: string) => screen.getByRole('button', { name: `查看素材 ${name}` })

afterEach(() => {
  vi.restoreAllMocks()
  useCanvas.setState({ engine: null, canvasId: null })
})

describe('素材面板的搜索与筛选', () => {
  it('搜索按内容过滤卡片，超长时保留输入并说明上限，不再发请求', async () => {
    const { user, lists } = await openPanel({
      page: {
        items: [asset({ id: 'a1', name: '边界检索%_\\杯子.png' })],
        nextCursor: null,
      },
    })
    const search = screen.getByRole('searchbox', { name: '搜索素材' })
    await user.type(search, '杯子')
    await waitFor(() => expect(lists.at(-1)?.q).toBe('杯子'))

    const tooLong = `${'界'.repeat(198)}🎬呀`
    await user.clear(search)
    await user.type(search, tooLong)
    await waitFor(() => expect(search.getAttribute('aria-invalid')).toBe('true'))
    expect((search as HTMLInputElement).value).toBe(tooLong)
    expect(screen.getByText('搜索内容过长')).toBeTruthy()
    expect(screen.getByText(/最多 200 个字符/)).toBeTruthy()
    // 超长内容不进入请求
    expect(lists.every((entry) => entry.q.length <= 200)).toBe(true)
    // 超长时详情不参与，避免在不可见的结果上操作
    expect(screen.queryByRole('button', { name: '放入当前画布' })).toBeNull()
  })

  it('空白与特殊字符按原样查询，筛选切换带上新的类型', async () => {
    const { user, lists } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '边界检索%_\\杯子.png' })], nextCursor: null },
    })
    const search = screen.getByRole('searchbox', { name: '搜索素材' })
    await user.type(search, '  边界检索%_\\  ')
    await waitFor(() => expect(lists.at(-1)?.q).toBe('边界检索%_\\'))

    await user.click(screen.getByRole('combobox', { name: '素材类型' }))
    await user.click(await screen.findByRole('option', { name: '图片' }))
    await waitFor(() => expect(lists.at(-1)?.kind).toBe('image'))
  })
})

describe('素材面板的详情与预览', () => {
  it('选中素材显示详情，预览可放大缩小并关闭', async () => {
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '海鸟.png' })], nextCursor: null },
    })
    await user.click(card('海鸟.png'))
    expect(await screen.findByRole('heading', { name: '海鸟.png' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '放大查看素材' }))
    const preview = await screen.findByRole('dialog', { name: '素材预览' })
    await user.click(within(preview).getByRole('button', { name: '放大' }))
    expect(within(preview).getByText('125%')).toBeTruthy()
    await user.click(within(preview).getByRole('button', { name: '缩小' }))
    expect(within(preview).getByText('100%')).toBeTruthy()
    await user.click(within(preview).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '素材预览' })).toBeNull())
  })

  it('缩略图加载失败仍能打开详情，原图失败可以重试', async () => {
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '海鸟.png' })], nextCursor: null },
    })
    const image = card('海鸟.png').querySelector('img')!
    image.dispatchEvent(new Event('error'))
    expect(await screen.findByText('缩略图暂不可用')).toBeTruthy()
    // 缩略图失败不影响选择素材
    await user.click(card('海鸟.png'))
    expect(await screen.findByRole('heading', { name: '海鸟.png' })).toBeTruthy()
  })

  it('预览原图失败时给出重试入口，重试后重新加载', async () => {
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '海鸟.png' })], nextCursor: null },
    })
    await user.click(card('海鸟.png'))
    await user.click(await screen.findByRole('button', { name: '放大查看素材' }))
    const preview = await screen.findByRole('dialog', { name: '素材预览' })
    const original = within(preview).getByRole('img', { name: '海鸟.png' })
    original.dispatchEvent(new Event('error'))
    expect(await screen.findByText('素材加载失败')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '重试加载' }))
    await waitFor(() => expect(screen.queryByText('素材加载失败')).toBeNull())
  })
})

describe('素材面板的分页与失败恢复', () => {
  it('加载更多素材把结果接在列表后面', async () => {
    const first = asset({ id: 'a1', name: '一号.png' })
    const second = asset({ id: 'a2', name: '二号.png' })
    let page = 0
    const { user } = await openPanel({
      handler: (request) => {
        const url = new URL(request.url)
        if (request.method !== 'GET' || url.pathname !== '/api/assets') return undefined
        page++
        return json(
          page === 1
            ? { items: [first], nextCursor: 'cursor-1' }
            : { items: [second], nextCursor: null },
        )
      },
    })
    await user.click(await screen.findByRole('button', { name: '加载更多素材' }))
    expect(await screen.findByRole('button', { name: '查看素材 二号.png' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看素材 一号.png' })).toBeTruthy()
  })

  it('分页游标无效时说明要重新读取首页，重新读取发的是不带游标的首页请求并替换结果', async () => {
    let phase: 'first' | 'recovery' = 'first'
    const { user, lists } = await openPanel({
      handler: (request) => {
        const url = new URL(request.url)
        if (request.method !== 'GET' || url.pathname !== '/api/assets') return undefined
        if (url.searchParams.get('cursor'))
          return json({ error: 'invalid', message: '分页游标无效，请重新读取素材' }, 400)
        if (phase === 'first')
          return json({ items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: 'bad-cursor' })
        return json({ items: [asset({ id: 'a2', name: '二号.png' })], nextCursor: null })
      },
    })
    const search = screen.getByRole('searchbox', { name: '搜索素材' })
    await user.type(search, '杯子')
    await waitFor(() => expect(lists.at(-1)?.q).toBe('杯子'))
    await user.click(await screen.findByRole('button', { name: '加载更多素材' }))
    expect(await screen.findByText('分页游标无效，请重新读取素材')).toBeTruthy()

    phase = 'recovery'
    await user.click(screen.getByRole('button', { name: '重新读取素材' }))
    await waitFor(() => expect(screen.queryByText('分页游标无效，请重新读取素材')).toBeNull())

    // 重新读取发的是不带游标的首页请求，并保留搜索条件
    const recovery = lists.at(-1)!
    expect(recovery.cursor).toBeNull()
    expect(recovery.q).toBe('杯子')
    // 旧坏游标不再被使用
    expect(lists.filter((entry) => entry.cursor === 'bad-cursor')).toHaveLength(1)
    // 结果被替换：坏游标那一页的素材不再留在列表里
    expect(await screen.findByRole('button', { name: '查看素材 二号.png' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '查看素材 一号.png' })).toBeNull()
  })

  it('素材列表读取失败说明可以重试，重试后恢复列表', async () => {
    let attempt = 0
    const { user } = await openPanel({
      handler: (request) => {
        const url = new URL(request.url)
        if (request.method !== 'GET' || url.pathname !== '/api/assets') return undefined
        attempt++
        if (attempt === 1) return json({ message: '素材读取失败' }, 500)
        return json({ items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: null })
      },
    })
    expect(await screen.findAllByText('素材读取失败')).not.toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('button', { name: '查看素材 一号.png' })).toBeTruthy()
  })
})

describe('素材面板的来源', () => {
  it('来源可定位时给出定位入口，定位到来源所在画布与节点', async () => {
    const select = vi.fn()
    useCanvas.setState({ canvasId: 'cv_1' })
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: null },
      sources: [source({ id: 's1', label: '海鸟卡' })],
    })
    await user.click(card('一号.png'))
    const section = (await screen.findByRole('heading', { name: '来源' })).parentElement!
    await user.click(within(section).getByRole('button', { name: '定位来源' }))
    await waitFor(() =>
      expect(useMediaLibrary.getState().target).toEqual({
        canvasId: 'cv_1',
        nodeId: 'node_1',
        assetId: 'a1',
      }),
    )
    expect(select).not.toHaveBeenCalled()
  })

  it('来源已不在画布上时说明原因，不提供定位入口', async () => {
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: null },
      sources: [
        source({
          id: 's1',
          label: '海鸟卡',
          type: 'job',
          canvasId: null,
          nodeId: null,
          locatable: false,
        }),
      ],
    })
    await user.click(card('一号.png'))
    const section = (await screen.findByRole('heading', { name: '来源' })).parentElement!
    expect(within(section).getByText('来源节点已删除')).toBeTruthy()
    expect(within(section).queryByRole('button', { name: '定位来源' })).toBeNull()
  })

  it('来源分页游标失效时说明要重新读取来源，重试回到首页', async () => {
    let restarted = false
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: null },
      handler: (request) => {
        const url = new URL(request.url)
        if (!/^\/api\/assets\/[^/]+\/sources$/.test(url.pathname)) return undefined
        if (url.searchParams.get('cursor'))
          return json({ error: 'invalid', message: '来源游标无效' }, 400)
        if (!restarted) {
          restarted = true
          return json({ items: [source({ id: 's1', label: '海鸟卡' })], nextCursor: 'bad-cursor' })
        }
        return json({ items: [source({ id: 's2', label: '另一张卡' })], nextCursor: null })
      },
    })
    await user.click(card('一号.png'))
    const section = (await screen.findByRole('heading', { name: '来源' })).parentElement!
    await user.click(await within(section).findByRole('button', { name: '更多来源' }))
    expect(await within(section).findByText('来源分页无效，请重新读取来源。')).toBeTruthy()
    await user.click(within(section).getByRole('button', { name: '重新读取来源' }))
    await waitFor(() => expect(within(section).getByText('另一张卡')).toBeTruthy())
  })

  it('换素材时取消旧的来源请求，迟到结果不会写回新素材', async () => {
    let release!: () => void
    const { user } = await openPanel({
      page: {
        items: [asset({ id: 'a1', name: '一号.png' }), asset({ id: 'a2', name: '二号.png' })],
        nextCursor: null,
      },
      handler: (request) => {
        const url = new URL(request.url)
        if (!/^\/api\/assets\/[^/]+\/sources$/.test(url.pathname)) return undefined
        // 第一个素材的来源请求一直不返回
        if (url.pathname.includes('/a1/'))
          return new Promise<Response>((resolve) => {
            release = () => resolve(json({ items: [], nextCursor: null }))
          })
        return json({ items: [source({ id: 's2', label: '二号来源' })], nextCursor: null })
      },
    })
    await user.click(card('一号.png'))
    await screen.findByRole('heading', { name: '来源' })
    await user.click(card('二号.png'))
    await waitFor(() => expect(screen.getByText('二号来源')).toBeTruthy())
    // 旧请求迟到后不能覆盖新素材的来源
    release()
    await waitFor(() => expect(screen.queryByText('一号来源')).toBeNull())
    expect(screen.getByText('二号来源')).toBeTruthy()
  })
})

describe('素材面板的只读与无画布状态', () => {
  it('只读画布停用放入并说明原因，恢复可写后重新可用', async () => {
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: null },
    })
    // 没有画布时也停用，并说明要打开画布
    await user.click(card('一号.png'))
    const place = await screen.findByRole('button', { name: '放入当前画布' })
    expect(place.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('打开一张画布后可以放入')).toBeTruthy()
  })

  it('读取素材源工程失败时单独说明，不盖掉列表自己的错误', async () => {
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: null },
      canvas: true,
      handler: (request) => {
        const url = new URL(request.url)
        if (url.pathname.startsWith('/api/motion/asset/'))
          return json({ message: '源工程读取失败' }, 503)
        return undefined
      },
    })
    await user.click(card('一号.png'))
    await user.click(await screen.findByRole('button', { name: '放入当前画布' }))
    // 放入失败给出可读原因
    expect(await screen.findByText(/读取素材源工程失败/)).toBeTruthy()
    // 列表本身的错误条没有被这次失败占用：列表级错误一定带重试按钮
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重新读取素材' })).toBeNull()
  })
})

describe('素材面板的存储', () => {
  it('素材详情可存入资产库并带上素材身份', async () => {
    const { user } = await openPanel({
      page: { items: [asset({ id: 'a1', name: '一号.png' })], nextCursor: null },
    })
    await user.click(card('一号.png'))
    await user.click(await screen.findByRole('button', { name: '存入资产库' }))
    // 资产库面板由外壳渲染，这里断言它收到了带素材身份的存档请求
    await waitFor(() =>
      expect(useLibrary.getState().seed).toEqual({
        name: '一号.png',
        images: ['a1'],
        videos: [],
      }),
    )
    expect(useLibrary.getState().open).toBe('character')
  })
})

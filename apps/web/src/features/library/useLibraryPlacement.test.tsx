// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createDoc } from '@plein/doc'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Asset, Catalog, LibraryItem } from '@plein/protocol'
import { useEffect } from 'react'
import { describe, expect, it } from 'vite-plus/test'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { mockFetch } from '../../testing/fetch'
import { act, renderApp, resetStoreAfterEach, screen, waitFor } from '../../testing/render'
import { placeInputOf } from './canvas'
import { useLibrary } from './store'
import { useLibraryPlacement } from './useLibraryPlacement'

resetStoreAfterEach(useLibrary)
resetStoreAfterEach(useCatalog)

const catalog = {
  nodes: corePlugin.nodes.map((node) => ({
    ...describeNode(node, 'plein/core'),
    executable: true,
  })),
  providers: [],
  prompts: [],
} as unknown as Catalog

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const asset = (id: string): Asset => ({
  id,
  kind: 'image',
  mime: 'image/png',
  name: 'ref.png',
  size: 1,
  width: 400,
  height: 600,
  variants: [],
  createdAt: 0,
})

const libraryItem = (assetId: string): LibraryItem => ({
  id: 'lib_1',
  kind: 'character',
  name: '林夏',
  projectId: null,
  description: '',
  tags: {},
  voice: null,
  images: [{ slot: 'extra', assetId }],
  video: null,
  models: [],
  profile: null,
  favorite: false,
  usedAt: null,
  createdAt: 0,
  updatedAt: 0,
})

const makeEngine = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const engine = {
    doc,
    camera: { viewRect: { x: 0, y: 0, w: 1000, h: 800 }, centerOn: () => {} },
    scene: { rect: () => null },
    selection: { set: () => {} },
    setTool: () => {},
  } as unknown as Engine
  return { doc, engine }
}

/** 素材元信息按 id 返回；handler 可以挂起或失败。使用记录一并接住。 */
function mockMeta(handler: (id: string) => Response | Promise<Response>) {
  mockFetch(async (request) => {
    const url = new URL(request.url)
    if (request.method === 'POST' && /^\/api\/library\/[^/]+\/use$/.test(url.pathname))
      return new Response(null, { status: 204 })
    if (request.method !== 'GET') return undefined
    const match = /^\/api\/assets\/([^/]+)\/meta$/.exec(url.pathname)
    if (!match) return undefined
    return handler(decodeURIComponent(match[1]!))
  })
}

type Placement = ReturnType<typeof useLibraryPlacement>

/** 把 hook 的返回值交给用例：放在 effect 里，避免在渲染过程中改外部变量。 */
function Harness({
  engine,
  onReady,
}: {
  engine: Engine | null
  onReady(placement: Placement): void
}) {
  const placement = useLibraryPlacement(engine)
  useEffect(() => {
    onReady(placement)
  }, [placement, onReady])
  return (
    <>
      <output data-testid="placing">{placement.placing ? 'true' : 'false'}</output>
      <output data-testid="error">{placement.error ?? ''}</output>
    </>
  )
}

/** 放入会同时铺出卡片和它的参考素材，只看卡片数量。 */
const cards = (doc: { elements(): Iterable<{ nodeType?: string }> }) =>
  [...doc.elements()].filter((el) => el.nodeType === 'plein/character')

const placing = () => screen.getByTestId('placing').textContent
const failure = () => screen.getByTestId('error').textContent ?? ''

describe('把资产放到画布上', () => {
  it('同一条目重复点击只放一次，不重复铺卡', async () => {
    mockMeta((id) => json(asset(id)))
    const { doc, engine } = makeEngine()
    useCanvas.setState({ engine })
    useCatalog.setState({ catalog })
    const input = placeInputOf(libraryItem('meta_1'))!
    let latest: Placement | null = null
    renderApp(<Harness engine={engine} onReady={(p) => (latest = p)} />)

    let results: unknown[] = []
    await act(async () => {
      results = await Promise.all([latest!.place(input), latest!.place(input)])
    })
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(cards(doc)).toHaveLength(1)
  })

  it('放入失败给出明确错误，素材恢复后可以直接重试', async () => {
    let broken = true
    mockMeta((id) =>
      broken
        ? json({ error: 'temporary_failure', message: '素材服务暂不可用' }, 503)
        : json(asset(id)),
    )
    const { doc, engine } = makeEngine()
    useCanvas.setState({ engine })
    useCatalog.setState({ catalog })
    const input = placeInputOf(libraryItem('meta_2'))!
    let latest: Placement | null = null
    renderApp(<Harness engine={engine} onReady={(p) => (latest = p)} />)

    await act(async () => {
      await latest!.place(input)
    })
    expect(failure()).toContain('放入资产失败')
    expect(failure()).toContain('素材服务暂不可用')
    expect(useCanvas.getState().notice).toContain('放入资产失败')
    expect(cards(doc)).toHaveLength(0)

    broken = false
    await act(async () => {
      await latest!.place(input)
    })
    await waitFor(() => expect(cards(doc)).toHaveLength(1))
    expect(failure()).toBe('')
    expect(placing()).toBe('false')
  })

  it('等待素材时换到别的画布，迟到结果不落到画布也不提示', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    mockMeta(async (id) => {
      await held
      return json(asset(id))
    })
    const first = makeEngine()
    const second = makeEngine()
    useCanvas.setState({ engine: first.engine })
    useCatalog.setState({ catalog })
    const input = placeInputOf(libraryItem('meta_3'))!
    let latest: Placement | null = null
    const { rerender } = renderApp(<Harness engine={first.engine} onReady={(p) => (latest = p)} />)

    let pending: Promise<unknown> | null = null
    await act(async () => {
      pending = latest!.place(input)
    })
    rerender(<Harness engine={second.engine} onReady={(p) => (latest = p)} />)
    release()
    await act(async () => {
      await pending
    })

    expect(cards(first.doc)).toHaveLength(0)
    expect(cards(second.doc)).toHaveLength(0)
    expect(useCanvas.getState().notice).toBeNull()
  })

  it('画布已经换了，进行中的状态要收干净，条目不会被永久卡住', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    mockMeta(async (id) => {
      await held
      return json(asset(id))
    })
    const { doc, engine } = makeEngine()
    const other = makeEngine()
    useCanvas.setState({ engine })
    useCatalog.setState({ catalog })
    const input = placeInputOf(libraryItem('meta_4'))!
    let latest: Placement | null = null
    renderApp(<Harness engine={engine} onReady={(p) => (latest = p)} />)

    let pending: Promise<unknown> | null = null
    await act(async () => {
      pending = latest!.place(input)
    })
    await waitFor(() => expect(placing()).toBe('true'))

    // 引擎换走但入口还在：这次放置必须作废，也不能把状态留在「正在放入」。
    useCanvas.setState({ engine: other.engine })
    release()
    await act(async () => {
      await pending
    })
    await waitFor(() => expect(placing()).toBe('false'))
    expect(cards(doc)).toHaveLength(0)

    // 回到原画布后同一条目仍然能放进去，没有被上一次失败卡住。
    useCanvas.setState({ engine })
    await act(async () => {
      await latest!.place(input)
    })
    await waitFor(() => expect(cards(doc)).toHaveLength(1))
  })
})

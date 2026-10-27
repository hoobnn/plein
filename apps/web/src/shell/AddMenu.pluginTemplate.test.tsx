// @vitest-environment happy-dom
import { type Engine } from '@plein/canvas-core'
import { openDoc } from '@plein/doc/testing'
import type { Catalog } from '@plein/protocol'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { mockFetch } from '../testing/fetch'
import { renderApp, resetStoreAfterEach, screen, waitFor } from '../testing/render'
import { AddMenu } from './AddMenu'

resetStoreAfterEach(useCatalog)

const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const node = {
  type: 'acme/text',
  version: 1,
  title: '文字',
  plugin: 'acme/tools',
  category: 'text',
  execution: 'inline',
  executable: false,
  defaults: { text: '默认文字' },
  paramsSchema: {},
  inputs: [{ id: 'in', type: 'text', label: '输入' }],
  outputs: [{ id: 'out', type: 'text', label: '输出' }],
}

const template = {
  id: 'acme/pair',
  plugin: 'acme/tools',
  title: '文字链',
  description: '两步文字',
  nodes: [
    {
      key: 'a',
      type: 'acme/text',
      version: 1,
      title: '第一步',
      x: -100,
      y: 80,
      params: { text: '自定义' },
    },
    { key: 'b', type: 'acme/text', version: 1, x: 300, y: 80 },
  ],
  edges: [{ from: ['a', 'out'], to: ['b', 'in'] }],
}

/** 目录：插件、它提供的节点和模板 */
function catalog(): Catalog {
  return {
    plugins: [
      {
        id: 'acme/tools',
        name: 'Acme 工具',
        version: '1.0.0',
        builtin: false,
        status: 'active',
        contributes: { nodes: ['acme/text@1'], templates: ['acme/pair'] },
        permissions: { network: [], secrets: [], assets: 'none' },
      },
    ],
    nodes: [node],
    providers: [],
    defaultModels: {},
    templates: [template],
    prompts: [],
    elements: [],
  } as unknown as Catalog
}

/** 服务端每次读目录给什么，由它说了算；其余请求不模拟，跑请求会被抓出来 */
function serve(read: () => Catalog | Promise<Catalog>) {
  return mockFetch(async (request) => {
    if (new URL(request.url).pathname === '/api/catalog') return Response.json(await read())
    return undefined
  })
}

/** 运行请求的次数：模板只插入节点，不该触发任何运行 */
function runCalls(fetch: ReturnType<typeof mockFetch>) {
  return fetch.mock.calls.filter(([, init]) => {
    const method = init?.method ?? 'GET'
    const path = String(init?.body ?? '')
    return method === 'POST' && path.includes('/run')
  })
}

function setup() {
  const doc = openDoc()
  docs.push(doc)
  const engine = { doc, selection: { set: vi.fn() }, setTool: vi.fn() } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'canvas-1' })
  useCatalog.setState({ catalog: catalog() })
  return { doc, engine }
}

const open = () =>
  renderApp(
    <AddMenu
      engine={useCanvas.getState().engine!}
      canImport={false}
      at={() => ({ x: 0, y: 0 })}
      onClose={() => {}}
    />,
  )

describe('插件模板在添加菜单里的行为', () => {
  it('按来源分组，整组插入、只占一次撤销，也不自动运行', async () => {
    const fetch = serve(() => catalog())
    const { doc } = setup()
    const { user } = open()
    await screen.findByText('插件模板 · Acme 工具')
    await user.click(screen.getByRole('option', { name: '文字链' }))

    await waitFor(() =>
      expect(useCanvas.getState().notice).toContain('已插入模板「文字链」，未运行任何节点'),
    )
    // 整组铺开：一个框 + 两个节点 + 一条连线
    expect([...doc.elements()]).toHaveLength(3)
    expect([...doc.edges()]).toHaveLength(1)
    // 模板里的参数和名字照搬到节点上
    expect([...doc.elements()].find((el) => el.name === '第一步')?.params).toEqual({
      text: '自定义',
    })
    // 模板不触发任何运行：既没有节点状态，也一次运行请求都没发
    expect([...doc.elements()].every((el) => !el.run && !el.results)).toBe(true)
    expect(runCalls(fetch)).toHaveLength(0)

    doc.undo.undo()
    expect([...doc.elements()]).toHaveLength(0)
    expect([...doc.edges()]).toHaveLength(0)

    // 重做后节点与连线都回来
    doc.undo.redo()
    expect([...doc.elements()]).toHaveLength(3)
    expect([...doc.edges()]).toHaveLength(1)
    expect([...doc.elements()].find((el) => el.name === '第一步')?.params).toEqual({
      text: '自定义',
    })
  })

  it('点下去之前目录里的模板变了：提示重新打开，不插半份', async () => {
    let calls = 0
    serve(() => {
      calls++
      const value = catalog()
      if (calls > 1) value.templates[0]!.nodes[0]!.params = { text: '换过的文字' }
      return value
    })
    const { doc } = setup()
    const { user } = open()
    await screen.findByRole('option', { name: '文字链' })
    await user.click(screen.getByRole('option', { name: '文字链' }))

    await waitFor(() =>
      expect(useCanvas.getState().notice).toContain('模板已更新，请重新打开添加菜单后插入'),
    )
    expect([...doc.elements()]).toHaveLength(0)
    expect([...doc.edges()]).toHaveLength(0)
  })

  it('模板依赖的节点被移走：提示缺节点，不插半份', async () => {
    let calls = 0
    serve(() => {
      calls++
      const value = catalog()
      if (calls > 1) value.nodes = []
      return value
    })
    const { doc } = setup()
    const { user } = open()
    await screen.findByRole('option', { name: '文字链' })
    await user.click(screen.getByRole('option', { name: '文字链' }))

    await waitFor(() =>
      expect(useCanvas.getState().notice).toContain('模板需要未安装的节点 acme/text@1'),
    )
    expect([...doc.elements()]).toHaveLength(0)
  })

  it('目录还没读完人就离开了画布：不往旧画布写东西', async () => {
    let release = () => {}
    const held = new Promise<Catalog>((resolve) => {
      release = () => resolve(catalog())
    })
    serve(() => held)
    const { doc } = setup()
    const { user } = open()
    await screen.findByRole('option', { name: '文字链' })
    await user.click(screen.getByRole('option', { name: '文字链' }))
    // 目录读取还在路上：这时人已经离开这个画布
    useCanvas.setState({ canvasId: 'canvas-2' })
    release()
    await waitFor(() => expect(useCanvas.getState().notice).toBeNull())
    expect([...doc.elements()]).toHaveLength(0)
  })
})

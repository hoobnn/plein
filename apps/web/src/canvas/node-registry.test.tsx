// @vitest-environment happy-dom
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import {
  ANIMATIC_TYPE,
  AI_SCENE_TYPE,
  corePlugin,
  MOTION_TYPE,
  SEQUENCE_TYPE,
  SHOT_ANALYSIS_TYPE,
  STAGE_TYPE,
  STORYBOARD_TYPE,
} from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { PREPARED_INPUT_VERSION, type Catalog, type PreparedInput } from '@plein/protocol'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { Generator } from '../features/generator/Generator'
import { CanvasMenus } from '../shell/CanvasMenus'
import { ResultBar } from '../shell/ResultBar'
import { mediaTestEngine } from '../shell/media-tools/testEngine'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { mockFetch } from '../testing/fetch'
import { act, fireEvent, renderApp, resetStoreAfterEach, screen, waitFor } from '../testing/render'
import { CanvasView } from './CanvasView'
import { activateNode, rendererRegistry } from './node-registry'
import { RendererRegistry } from '@plein/canvas-core'

// CanvasView 的引擎边界用可观测替身：捕获构造参数，验证渲染器注册表注入
const h = vi.hoisted(() => ({ engines: [] as Array<{ opts: Record<string, unknown> }> }))
vi.mock('@plein/canvas-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plein/canvas-core')>()
  class Engine {
    opts: Record<string, unknown>
    scene: InstanceType<typeof actual.Scene>
    state = { tool: 'select' }
    camera = {
      viewRect: { x: 0, y: 0, w: 1000, h: 800 },
      insets: { left: 0, right: 0, top: 0, bottom: 0 },
      onChange: () => () => {},
      onInsetsChange: () => () => {},
    }
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      this.scene = new actual.Scene(opts.doc as never)
      h.engines.push(this)
    }
    init() {
      return Promise.resolve()
    }
    destroy() {}
    onActivate() {
      return () => {}
    }
    onStateChange() {
      return () => {}
    }
    onMenu() {
      return () => {}
    }
    onArrange() {
      return () => {}
    }
    zoomToFit() {}
    setTheme() {}
  }
  return { ...actual, Engine }
})
vi.mock('./overlays', () => ({
  CanvasOverlays: class {
    activate() {}
    destroy() {}
  },
}))
vi.mock('./shotBadges', () => ({
  ShotBadges: class {
    destroy() {}
  },
}))
vi.mock('./nodeCards', () => ({
  NodeCards: class {
    destroy() {}
  },
}))
// demo 封面用 canvas 2d 画渐变，happy-dom 拿不到 2d 上下文；种子文档仍用真的
vi.mock('./demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./demo')>()
  return {
    ...actual,
    demoAssetUrls: () => new Map<string, string>(),
    releaseDemoAssetUrls: () => {},
  }
})

resetStoreAfterEach(useCatalog)

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

const catalog = {
  plugins: [],
  nodes: corePlugin.nodes.map((node) => ({
    ...describeNode(node, 'plein/core'),
    executable: true,
  })),
  providers: [],
  defaultModels: {},
  templates: [],
  prompts: [],
} as unknown as Catalog

/** 画布上放一个指定类型的节点；ports 只是为了满足元素形状，编辑器分发不读它 */
function putNode(doc: PleinDoc, nodeType: string, extra: Record<string, unknown> = {}) {
  return createElement(doc, {
    kind: 'node',
    nodeType,
    x: 0,
    y: 0,
    w: 300,
    h: 180,
    params: {},
    ports: { inputs: [], outputs: [{ id: 'image', label: '输出', type: 'image' }] },
    ...extra,
  })
}

function engineFor(doc: PleinDoc, id: string) {
  const engine = mediaTestEngine(doc)
  engine.selection.values = () => [id]
  engine.worldToClient = (x, y) => ({ x, y })
  return engine
}

/** 生成器面板渲染时会准备一次实际输入；给一份通用的就绪结果 */
function mockPreparedInput() {
  mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && /^\/api\/canvases\/[^/]+\/nodes\/[^/]+\/input$/.test(path))
      return Response.json({
        v: PREPARED_INPUT_VERSION,
        nodeId: 'n',
        nodeType: 'plein/x',
        preparedAt: 1,
        status: 'ready',
        params: {},
        inputs: {},
        refs: [],
        blocked: [],
        notices: [],
      } satisfies PreparedInput)
    if (path === '/api/media/caps') return Response.json({ ffmpeg: false })
    return undefined
  })
}

async function setup(doc: PleinDoc, id: string) {
  useCanvas.setState({ engine: engineFor(doc, id), canvasId: 'canvas' })
  useCatalog.setState({ catalog })
  const view = renderApp(<Generator />)
  return view
}

/** 带一个图片结果的锁定节点：结果条按「有结果的锁定节点」渲染浮动工具条 */
function withImageResult(nodeType: string) {
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType,
    x: 0,
    y: 0,
    w: 300,
    h: 180,
    params: {},
    locked: true,
    ports: { inputs: [], outputs: [{ id: 'image', label: '输出', type: 'image' }] },
    results: [
      { id: 'r', runId: 'run', port: 'image', at: 1, value: { type: 'image', assetId: 'a1' } },
    ],
  })
  return { doc, id }
}

describe('渲染器注册表注入', () => {
  it('CanvasView 注入由注册表生成的 RendererRegistry', async () => {
    useCatalog.setState({ catalog })
    const view = renderApp(<CanvasView source={{ kind: 'demo', count: 1 }} />)
    await waitFor(() => expect(h.engines.length).toBeGreaterThan(0))
    expect(h.engines[0]!.opts.renderers).toBeInstanceOf(RendererRegistry)
    await act(async () => {
      view.unmount()
    })
  })

  it('rendererRegistry() 的 nodeType 层不改变默认渲染路径', () => {
    const doc = openDoc()
    docs.push(doc)
    const id = createElement(doc, {
      kind: 'node',
      nodeType: STORYBOARD_TYPE,
      x: 0,
      y: 0,
      w: 200,
      h: 120,
      params: {},
      ports: { inputs: [], outputs: [] },
    })
    // 未登记 nodeType 渲染器：走 node 通用渲染器（有预览档位），不是占位卡片
    const itemView = rendererRegistry().create(doc.get(id)!, {})
    expect(itemView.previewStatus).not.toBeUndefined()
    itemView.destroy()
  })
})

describe('双击节点的打开行为（activateNode）', () => {
  /** 放一个节点并模拟双击；rAF 是未登记节点聚焦生成器的延迟 */
  async function activate(nodeType: string) {
    const doc = openDoc()
    docs.push(doc)
    const id = createElement(doc, {
      kind: 'node',
      nodeType,
      x: 0,
      y: 0,
      w: 200,
      h: 120,
      params: {},
      ports: { inputs: [], outputs: [] },
    })
    activateNode(doc.get(id)!)
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return id
  }

  it('分镜、序列、节奏样片、3D 构图、动态合成各自进专属编辑器', async () => {
    const spies = {
      openStoryboard: vi.fn(),
      openSequence: vi.fn(),
      openStage: vi.fn(),
      openMotion: vi.fn(),
    }
    useCanvas.setState(spies)
    await activate(STORYBOARD_TYPE)
    await activate(SEQUENCE_TYPE)
    await activate(ANIMATIC_TYPE)
    await activate(STAGE_TYPE)
    await activate(MOTION_TYPE)
    expect(spies.openStoryboard).toHaveBeenCalledTimes(1)
    expect(spies.openSequence).toHaveBeenCalledTimes(2)
    expect(spies.openStage).toHaveBeenCalledTimes(1)
    expect(spies.openMotion).toHaveBeenCalledTimes(1)
  })

  it('未登记的节点聚焦生成器', async () => {
    const listener = vi.fn()
    window.addEventListener('plein:focus-generator', listener)
    try {
      const id = await activate('plein/image')
      expect((listener.mock.calls[0]![0] as CustomEvent).detail).toBe(id)
    } finally {
      window.removeEventListener('plein:focus-generator', listener)
    }
  })

  it('非节点元素不分发', async () => {
    const listener = vi.fn()
    const openStoryboard = vi.fn()
    useCanvas.setState({ openStoryboard })
    window.addEventListener('plein:focus-generator', listener)
    try {
      const doc = openDoc()
      docs.push(doc)
      const id = createElement(doc, { kind: 'image', assetId: 'a', x: 0, y: 0, w: 100, h: 80 })
      activateNode(doc.get(id)!)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      expect(listener).not.toHaveBeenCalled()
      expect(openStoryboard).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('plein:focus-generator', listener)
    }
  })
})

describe('Generator 编辑器按节点类型分发（对照：改前改后一致）', () => {
  it.each([
    ['分镜节点显示编辑分镜表入口', STORYBOARD_TYPE, '编辑分镜表（0 个镜头）'],
    ['序列节点显示编辑序列入口', SEQUENCE_TYPE, '编辑序列（0 段镜头）'],
    ['节奏样片节点显示编辑节奏样片入口', ANIMATIC_TYPE, '编辑节奏样片'],
    ['3D 构图节点显示打开 3D 构图入口', STAGE_TYPE, '打开 3D 构图'],
    ['拉片节点显示打开拉片清单入口', SHOT_ANALYSIS_TYPE, '打开拉片清单'],
  ])('%s', async (_title, nodeType, entry) => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, nodeType)
    await setup(doc, id)
    expect(screen.getByTestId('node-editor')).toBeTruthy()
    expect(screen.getByTestId('generator')).toBeTruthy()
    expect(screen.getByRole('button', { name: entry })).toBeTruthy()
  })

  it('角色节点显示角色档案摘要', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, 'plein/character')
    await setup(doc, id)
    expect(screen.getByTestId('generator')).toBeTruthy()
    expect(screen.getByLabelText('角色档案')).toBeTruthy()
  })

  it('AI 分析草稿未锁定时入口替代生成面板', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, AI_SCENE_TYPE)
    await setup(doc, id)
    expect(screen.getByTestId('node-editor')).toBeTruthy()
    expect(screen.queryByTestId('generator')).toBeNull()
    expect(screen.getByRole('button', { name: '查看 AI 分析与预检' })).toBeTruthy()
  })

  it('AI 分析草稿锁定时浮出入口，没有节点编辑器', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, AI_SCENE_TYPE, { locked: true })
    await setup(doc, id)
    expect(screen.queryByTestId('node-editor')).toBeNull()
    expect(screen.getByRole('button', { name: '查看 AI 分析与预检' })).toBeTruthy()
  })

  it('锁定普通节点没有编辑器入口', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, 'plein/image', { locked: true })
    await setup(doc, id)
    expect(screen.queryByTestId('node-editor')).toBeNull()
    expect(screen.queryByTestId('generator')).toBeNull()
  })

  it('AI 分析入口点击后打开 AI 分析面板', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, AI_SCENE_TYPE)
    const openAiAnalysis = vi.fn()
    useCanvas.setState({ openAiAnalysis })
    await setup(doc, id)
    fireEvent.click(screen.getByRole('button', { name: '查看 AI 分析与预检' }))
    expect(openAiAnalysis).toHaveBeenCalledWith({ kind: 'node', nodeId: id })
  })
})

describe('结果条按节点类型分发（对照：改前改后一致）', () => {
  it('锁定的拉片节点给查看拉片清单入口', async () => {
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, SHOT_ANALYSIS_TYPE, { locked: true })
    const openShotAnalysis = vi.fn()
    useCanvas.setState({ engine: engineFor(doc, id), canvasId: 'canvas', openShotAnalysis })
    useCatalog.setState({ catalog })
    renderApp(<ResultBar />)
    const button = await screen.findByRole('button', { name: '查看拉片清单' })
    fireEvent.click(button)
    expect(openShotAnalysis).toHaveBeenCalledWith(id)
  })

  it('非锁定拉片节点不给查看拉片清单入口（生成器里有）', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, SHOT_ANALYSIS_TYPE)
    useCanvas.setState({ engine: engineFor(doc, id), canvasId: 'canvas' })
    useCatalog.setState({ catalog })
    renderApp(
      <>
        <Generator />
        <ResultBar />
      </>,
    )
    await waitFor(() => expect(screen.getByTestId('generator')).toBeTruthy())
    expect(screen.queryByRole('button', { name: '查看拉片清单' })).toBeNull()
  })

  it('构图截图不提供再加工入口，普通视频结果保留媒体工具', async () => {
    mockPreparedInput()
    const stage = withImageResult(STAGE_TYPE)
    useCanvas.setState({ engine: engineFor(stage.doc, stage.id), canvasId: 'canvas' })
    useCatalog.setState({ catalog })
    const view = renderApp(<ResultBar />)
    await screen.findByRole('button', { name: '全屏查看' })
    expect(screen.queryByRole('button', { name: '媒体工具' })).toBeNull()
    expect(screen.queryByRole('button', { name: /预设/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /宫格切分/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /生成视频/ })).toBeNull()
    await act(async () => view.unmount())

    const video = withImageResult('plein/video')
    useCanvas.setState({ engine: engineFor(video.doc, video.id), canvasId: 'canvas' })
    renderApp(<ResultBar />)
    await screen.findByRole('button', { name: '媒体工具' })
    expect(screen.getByRole('button', { name: '全屏查看' })).toBeTruthy()
  })
})

describe('右键菜单按节点类型分发（对照：改前改后一致）', () => {
  function menuEngine(doc: PleinDoc, id: string) {
    const engine = engineFor(doc, id)
    useCanvas.setState({
      engine,
      canvasId: 'canvas',
      menu: { kind: 'context', target: id, client: { x: 10, y: 10 }, world: { x: 10, y: 10 } },
    })
    useCatalog.setState({ catalog })
    return engine
  }

  it('场景节点的右键菜单有场景准备，点击打开准备视图', async () => {
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, 'plein/scene')
    const openScenePrep = vi.fn()
    useCanvas.setState({ openScenePrep })
    menuEngine(doc, id)
    renderApp(<CanvasMenus canImport />)
    const item = await screen.findByRole('menuitem', { name: '场景准备' })
    fireEvent.click(item)
    expect(openScenePrep).toHaveBeenCalledWith(id)
    expect(useCanvas.getState().menu).toBeNull()
  })

  it('其他节点的右键菜单没有场景准备', async () => {
    const doc = openDoc()
    docs.push(doc)
    const video = putNode(doc, 'plein/video')
    menuEngine(doc, video)
    renderApp(<CanvasMenus canImport />)
    await screen.findByRole('menuitem', { name: /生成/ })
    expect(screen.queryByRole('menuitem', { name: '场景准备' })).toBeNull()
  })

  it('多选时没有场景准备', async () => {
    const doc = openDoc()
    docs.push(doc)
    const first = putNode(doc, 'plein/scene')
    const second = putNode(doc, 'plein/scene', { x: 400, y: 0 })
    const engine = menuEngine(doc, first)
    renderApp(<CanvasMenus canImport />)
    await screen.findByRole('menuitem', { name: '场景准备' })
    await act(async () => {
      engine.selection.values = () => [first, second]
      useCanvas.setState({
        menu: { kind: 'context', target: first, client: { x: 10, y: 10 }, world: { x: 10, y: 10 } },
      })
    })
    await waitFor(() => {
      const items = screen.getAllByRole('menuitem')
      expect(items.some((el) => el.textContent === '场景准备')).toBe(false)
    })
  })
})

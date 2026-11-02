// @vitest-environment happy-dom
//
// 打开行为与编辑器分发的对照测试：只经生产组件（CanvasView / Generator /
// ResultBar）验证，不 import 内部实现；checkout 旧版分发文件也能全绿，
// 用于证明这些用例钉住的是改前行为。
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import {
  AI_SCENE_TYPE,
  AI_SUMMARY_TYPE,
  ANIMATIC_TYPE,
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
import { ResultBar } from '../shell/ResultBar'
import { mediaTestEngine } from '../shell/media-tools/testEngine'
import { useCanvas } from '../stores/canvas'
import { useCatalog } from '../stores/catalog'
import { mockFetch } from '../testing/fetch'
import { act, fireEvent, renderApp, resetStoreAfterEach, screen, waitFor } from '../testing/render'
import { CanvasView } from './CanvasView'

// CanvasView 的引擎边界用可观测替身：捕获构造参数与 onActivate 注册的
// 实际激活回调，双击分发从这条真实接线验证。
const h = vi.hoisted(() => ({
  engines: [] as Array<{ opts: Record<string, unknown>; doc: PleinDoc }>,
  activate: [] as Array<(id: string) => void>,
}))

vi.mock('@plein/canvas-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@plein/canvas-core')>()
  class Engine {
    opts: Record<string, unknown>
    doc: PleinDoc
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
      this.doc = opts.doc as PleinDoc
      this.scene = new actual.Scene(this.doc)
      h.engines.push(this)
    }
    init() {
      return Promise.resolve()
    }
    destroy() {}
    onActivate(fn: (id: string) => void) {
      h.activate.push(fn)
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
    get stats() {
      return { markdown: 0, assetMeta: 0 }
    }
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
afterEach(() => {
  h.engines.length = 0
  h.activate.length = 0
  docs.splice(0).forEach((doc) => doc.destroy())
})

const PRESET = {
  id: 'test/preset',
  plugin: 'test',
  title: '测试预设',
  template: '测试模板',
  appliesTo: ['image.generate'],
}

const catalog = {
  plugins: [],
  nodes: corePlugin.nodes.map((node) => ({
    ...describeNode(node, 'plein/core'),
    executable: true,
  })),
  providers: [],
  defaultModels: {},
  templates: [],
  prompts: [PRESET],
} as unknown as Catalog

/** 画布上放一个指定类型的节点；ports 只是为了满足元素形状，分发不读它 */
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

async function setup(doc: PleinDoc, id: string, canvasId: string | null = 'canvas') {
  useCanvas.setState({ engine: engineFor(doc, id), canvasId })
  useCatalog.setState({ catalog })
  return renderApp(<Generator />)
}

/** 带一个图片结果的节点（可选锁定）：结果条与生成器内联操作用 */
function withImageResult(nodeType: string, locked = false) {
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
    locked,
    ports: { inputs: [], outputs: [{ id: 'image', label: '输出', type: 'image' }] },
    results: [
      { id: 'r', runId: 'run', port: 'image', at: 1, value: { type: 'image', assetId: 'a1' } },
    ],
  })
  return { doc, id }
}

/** 渲染 CanvasView 的演示画布，等引擎就绪；返回 demo 文档与实际激活回调 */
async function setupCanvas() {
  useCatalog.setState({ catalog })
  renderApp(<CanvasView source={{ kind: 'demo', count: 1 }} />)
  await waitFor(() => expect(h.activate.length).toBeGreaterThan(0))
  return { doc: h.engines[0]!.doc, activate: h.activate[0]! }
}

const raf = () => new Promise((resolve) => requestAnimationFrame(resolve))

describe('CanvasView 双击分发（经实际激活回调，含节点 ID）', () => {
  it('分镜、序列、节奏样片、3D 构图、动态合成各自进专属编辑器', async () => {
    const spies = {
      openStoryboard: vi.fn(),
      openSequence: vi.fn(),
      openStage: vi.fn(),
      openMotion: vi.fn(),
    }
    useCanvas.setState(spies)
    const { doc, activate } = await setupCanvas()
    const storyboard = putNode(doc, STORYBOARD_TYPE)
    const sequence = putNode(doc, SEQUENCE_TYPE, { x: 400 })
    const animatic = putNode(doc, ANIMATIC_TYPE, { x: 800 })
    const stage = putNode(doc, STAGE_TYPE, { x: 1200 })
    const motion = putNode(doc, MOTION_TYPE, { x: 1600 })
    activate(storyboard)
    activate(sequence)
    activate(animatic)
    activate(stage)
    activate(motion)
    expect(spies.openStoryboard).toHaveBeenCalledTimes(1)
    expect(spies.openStoryboard).toHaveBeenCalledWith(storyboard)
    expect(spies.openSequence).toHaveBeenCalledTimes(2)
    expect(spies.openSequence).toHaveBeenCalledWith(sequence)
    expect(spies.openSequence).toHaveBeenCalledWith(animatic)
    expect(spies.openStage).toHaveBeenCalledWith(stage)
    expect(spies.openMotion).toHaveBeenCalledWith(motion)
  })

  it('未登记的节点聚焦生成器，事件带节点 ID', async () => {
    const listener = vi.fn()
    window.addEventListener('plein:focus-generator', listener)
    try {
      const { doc, activate } = await setupCanvas()
      const id = putNode(doc, 'plein/image')
      activate(id)
      await raf()
      expect(listener.mock.calls[0]![0] as CustomEvent).toMatchObject({ detail: id })
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
      const { doc, activate } = await setupCanvas()
      const id = createElement(doc, {
        kind: 'image',
        assetId: 'demo:0',
        x: 0,
        y: 0,
        w: 100,
        h: 80,
      })
      activate(id)
      await raf()
      expect(listener).not.toHaveBeenCalled()
      expect(openStoryboard).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('plein:focus-generator', listener)
    }
  })
})

describe('Generator 编辑器分发（对照：改前改后一致）', () => {
  it.each([
    ['AI 场景草稿', AI_SCENE_TYPE],
    ['AI 摘要草稿', AI_SUMMARY_TYPE],
  ])('%s未锁定时入口替代生成面板，点击打开 AI 分析', async (_title, nodeType) => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, nodeType)
    const openAiAnalysis = vi.fn()
    useCanvas.setState({ openAiAnalysis })
    await setup(doc, id)
    expect(screen.getByTestId('node-editor')).toBeTruthy()
    expect(screen.queryByTestId('generator')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看 AI 分析与预检' }))
    expect(openAiAnalysis).toHaveBeenCalledWith({ kind: 'node', nodeId: id })
  })

  it.each([
    ['AI 场景草稿', AI_SCENE_TYPE],
    ['AI 摘要草稿', AI_SUMMARY_TYPE],
  ])('%s锁定时浮出入口，没有节点编辑器', async (_title, nodeType) => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, nodeType, { locked: true })
    await setup(doc, id)
    expect(screen.queryByTestId('node-editor')).toBeNull()
    expect(screen.getByRole('button', { name: '查看 AI 分析与预检' })).toBeTruthy()
  })

  it('只读画布上 AI 草稿浮出入口，普通节点没有编辑器', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const draft = putNode(doc, AI_SCENE_TYPE)
    const plain = putNode(doc, 'plein/image', { x: 800 })
    doc.readOnly = true
    let view = await setup(doc, draft)
    expect(screen.queryByTestId('node-editor')).toBeNull()
    expect(screen.getByRole('button', { name: '查看 AI 分析与预检' })).toBeTruthy()
    await act(async () => {
      view.unmount()
    })
    view = await setup(doc, plain)
    expect(screen.queryByTestId('node-editor')).toBeNull()
    expect(screen.queryByTestId('generator')).toBeNull()
    await act(async () => {
      view.unmount()
    })
  })

  it('AI 草稿用入口尺寸（560×96），3D 构图用构图尺寸（420×180）', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const draft = putNode(doc, AI_SCENE_TYPE)
    let view = await setup(doc, draft)
    const editor = screen.getByTestId('node-editor') as HTMLElement
    expect(Number.parseInt(editor.style.width)).toBe(560)
    expect(Number.parseInt(editor.style.height)).toBe(96)
    await act(async () => {
      view.unmount()
    })
    const stage = putNode(doc, STAGE_TYPE, { x: 800 })
    view = await setup(doc, stage)
    const stageEditor = screen.getByTestId('node-editor') as HTMLElement
    expect(Number.parseInt(stageEditor.style.width)).toBe(420)
    expect(Number.parseInt(stageEditor.style.height)).toBe(180)
    await act(async () => {
      view.unmount()
    })
  })

  it('stage 截图提示按有无截图切换文案', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const bare = putNode(doc, STAGE_TYPE)
    let view = await setup(doc, bare)
    expect(screen.getByText('摆好人物和机位后截图，把「构图」连到图片节点的参考图')).toBeTruthy()
    await act(async () => {
      view.unmount()
    })
    const shot = putNode(doc, STAGE_TYPE, {
      x: 800,
      params: {
        snapshots: [
          {
            resultId: 'r1',
            assetId: 'a1',
            rev: 1,
            render: 1,
            scene: { aspect: '16:9', figures: [], blocks: [], camera: {}, rev: 0 },
            at: 1,
          },
        ],
      },
    })
    view = await setup(doc, shot)
    expect(screen.getByText(/已截 1 张，下游用当前采用的那张/)).toBeTruthy()
    await act(async () => {
      view.unmount()
    })
  })

  it('角色节点没有 canvasId（本地演示）时不显示角色档案', async () => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, 'plein/character')
    await setup(doc, id, null)
    expect(screen.getByTestId('generator')).toBeTruthy()
    expect(screen.queryByLabelText('角色档案')).toBeNull()
  })

  it.each([
    ['分镜入口打开分镜表', STORYBOARD_TYPE, '编辑分镜表（0 个镜头）', 'openStoryboard'],
    ['序列入口打开序列', SEQUENCE_TYPE, '编辑序列（0 段镜头）', 'openSequence'],
    ['节奏样片入口打开序列', ANIMATIC_TYPE, '编辑节奏样片', 'openSequence'],
    ['3D 构图入口打开构图', STAGE_TYPE, '打开 3D 构图', 'openStage'],
    ['拉片入口打开拉片清单', SHOT_ANALYSIS_TYPE, '打开拉片清单', 'openShotAnalysis'],
  ])('%s', async (_title, nodeType, entry, action) => {
    mockPreparedInput()
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, nodeType)
    const spy = vi.fn()
    useCanvas.setState({ [action]: spy } as unknown as Parameters<typeof useCanvas.setState>[0])
    await setup(doc, id)
    fireEvent.click(screen.getByRole('button', { name: entry }))
    expect(spy).toHaveBeenCalledWith(id)
  })
})

describe('结果条与生成器内联操作按节点类型分发（对照：改前改后一致）', () => {
  /** 锁定节点的浮动结果条：先普通图片（对照组，显示加工入口），再构图截图（隐藏） */
  it('普通图片显示预设与局部重绘，构图截图隐藏全部再加工入口', async () => {
    mockPreparedInput()
    const plain = withImageResult('plein/image', true)
    useCanvas.setState({ engine: engineFor(plain.doc, plain.id), canvasId: 'canvas' })
    useCatalog.setState({ catalog })
    let view = renderApp(<ResultBar />)
    await screen.findByRole('button', { name: /预设/ })
    expect(screen.getByRole('button', { name: /生成视频/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '局部重绘' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /宫格切分/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '媒体工具' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '全屏查看' })).toBeTruthy()
    await act(async () => {
      view.unmount()
    })

    const stage = withImageResult(STAGE_TYPE, true)
    useCanvas.setState({ engine: engineFor(stage.doc, stage.id), canvasId: 'canvas' })
    view = renderApp(<ResultBar />)
    await screen.findByRole('button', { name: '全屏查看' })
    expect(screen.queryByRole('button', { name: /预设/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /生成视频/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '局部重绘' })).toBeNull()
    expect(screen.queryByRole('button', { name: /宫格切分/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '媒体工具' })).toBeNull()
    expect(screen.getByRole('button', { name: '全屏查看' })).toBeTruthy()
    await act(async () => {
      view.unmount()
    })
  })

  /** 生成器内联操作（variant="inline"）：普通图片显示，构图截图隐藏 */
  it('生成器内联操作对构图截图隐藏再加工入口', async () => {
    mockPreparedInput()
    const plain = withImageResult('plein/image')
    let view = await setup(plain.doc, plain.id)
    await screen.findByTestId('generator')
    await screen.findByRole('button', { name: /预设/ })
    expect(screen.getByRole('button', { name: '局部重绘' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /宫格切分/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '媒体工具' })).toBeTruthy()
    await act(async () => {
      view.unmount()
    })

    const stage = withImageResult(STAGE_TYPE)
    view = await setup(stage.doc, stage.id)
    await screen.findByRole('button', { name: '打开 3D 构图' })
    expect(screen.queryByRole('button', { name: /预设/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '局部重绘' })).toBeNull()
    expect(screen.queryByRole('button', { name: /宫格切分/ })).toBeNull()
    expect(screen.queryByRole('button', { name: '媒体工具' })).toBeNull()
    await act(async () => {
      view.unmount()
    })
  })

  it('只读画布上的拉片节点给查看拉片清单入口', async () => {
    const doc = openDoc()
    docs.push(doc)
    const id = putNode(doc, SHOT_ANALYSIS_TYPE)
    doc.readOnly = true
    const openShotAnalysis = vi.fn()
    useCanvas.setState({ engine: engineFor(doc, id), canvasId: 'canvas', openShotAnalysis })
    useCatalog.setState({ catalog })
    renderApp(<ResultBar />)
    const button = await screen.findByRole('button', { name: '查看拉片清单' })
    fireEvent.click(button)
    expect(openShotAnalysis).toHaveBeenCalledWith(id)
  })
})

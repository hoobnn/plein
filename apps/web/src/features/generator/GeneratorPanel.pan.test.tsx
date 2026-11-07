// @vitest-environment happy-dom
import type { Engine } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { mockFetch } from '../../testing/fetch'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import { act, fireEvent, renderApp, resetStoreAfterEach } from '../../testing/render'
import { Generator } from './Generator'

resetStoreAfterEach(useCatalog)

const docs: PleinDoc[] = []
afterEach(() => {
  docs.splice(0).forEach((doc) => doc.destroy())
  vi.useRealTimers()
})

const node = {
  ...describeNode(
    corePlugin.nodes.find((n) => n.type === 'plein/image')!,
    'plein/core',
  ),
  executable: true,
}

const catalog = {
  providers: [],
  nodes: [node],
  templates: [],
  prompts: [],
  plugins: [],
  defaultModels: {},
} as unknown as Catalog

/** 节点左半截在窗口外：选中后需要把相机平移过去 */
function setup() {
  vi.useFakeTimers()
  mockFetch(() => Response.json({}))
  const doc = openDoc()
  docs.push(doc)
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/image',
    name: '需要平移的图片',
    x: -100,
    y: 100,
    w: 200,
    h: 60,
    params: {},
    ports: { inputs: node.inputs, outputs: node.outputs },
  })
  const subscribe = () => () => {}
  const engine = {
    doc,
    selection: { set: vi.fn(), values: () => [id], has: () => true, onChange: subscribe },
    scene: { get: (i: string) => doc.get(i) },
    onStateChange: subscribe,
    onViewChange: subscribe,
    onMove: subscribe,
    onActivate: subscribe,
    setTool: vi.fn(),
    zoomToFit: vi.fn(),
    glideBy: vi.fn(),
    stopGlide: vi.fn(),
    glideRemaining: { x: 0, y: 0 },
    visibleIds: [],
    highDetail: false,
    camera: {
      onChange: subscribe,
      onInsetsChange: subscribe,
      insets: { left: 0, right: 0, top: 0, bottom: 0 },
      width: 1000,
      height: 800,
      zoom: 1,
      viewRect: { x: 0, y: 0, w: 1000, h: 800 },
      worldToScreen: (x: number, y: number) => ({ x, y }),
      centerOn: vi.fn(),
    },
    worldToClient: (x: number, y: number) => ({ x, y }),
    state: { tool: 'select' },
  } as unknown as Engine
  useCatalog.setState({ catalog })
  useCanvas.setState({ engine, canvasId: 'canvas' })
  return { engine, render: () => renderApp(<Generator />) }
}

describe('生成面板放不下时的相机平移', () => {
  it('没有按着指针时，等一个双击间隔后平移', () => {
    const { engine, render } = setup()
    render()
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(engine.glideBy).toHaveBeenCalledTimes(1)
  })

  it('按住刚选中的节点拖动时不平移，松开后才计时', () => {
    const { engine, render } = setup()
    // 选中节点的那次按下发生在面板挂载之前
    fireEvent.pointerDown(window, { pointerId: 7 })
    render()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(engine.glideBy).not.toHaveBeenCalled()

    fireEvent.pointerUp(window, { pointerId: 7 })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(engine.glideBy).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(engine.glideBy).toHaveBeenCalledTimes(1)
  })
})

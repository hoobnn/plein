import { Camera, Selection, type Engine } from '@plein/canvas-core'
import { deleteElements, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { useCanvas } from '../stores/canvas'
import { placeStartNode } from './start'
import { DRAMA_START, queueStartNode, takeStartNode } from './startQueue'

const catalog = {
  nodes: corePlugin.nodes.map((node) => ({
    ...describeNode(node, 'plein/core'),
    executable: true,
  })),
  providers: [],
  defaultModels: {},
} as unknown as Catalog
const docs: PleinDoc[] = []
const initial = useCanvas.getState()
afterEach(() => {
  takeStartNode('start-canvas')
  useCanvas.getState().notify(null)
  useCanvas.setState(initial, true)
  docs.splice(0).forEach((doc) => doc.destroy())
  vi.unstubAllGlobals()
})

function setup() {
  const doc = openDoc()
  docs.push(doc)
  const camera = new Camera()
  camera.setViewport(1200, 800)
  camera.panBy(120, 80)
  const engine = {
    doc,
    camera,
    selection: new Selection(),
    setTool: vi.fn(),
    zoomToFit: vi.fn(),
  } as unknown as Engine
  useCanvas.setState({ engine, canvasId: 'start-canvas' })
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  const target = new EventTarget()
  vi.stubGlobal('window', target)
  return {
    doc,
    engine,
    target,
    frame: () => frames.splice(0).forEach((callback) => callback(0)),
  }
}

it('快速开始在当前视口落下真实节点，只消费一次意图并聚焦对应生成器', () => {
  const f = setup()
  const focus = vi.fn()
  f.target.addEventListener('plein:focus-generator', focus)
  const view = f.engine.camera.viewRect
  queueStartNode('start-canvas', 'plein/image')
  placeStartNode(f.engine, catalog, 'start-canvas')
  const elements = [...f.doc.elements()]
  expect(elements).toHaveLength(1)
  const node = elements[0]!
  expect(node.nodeType).toBe('plein/image')
  expect(node.x).toBe(Math.round(view.x + view.w / 2 - node.w / 2))
  expect(node.y).toBe(Math.round(view.y + view.h * 0.36 - node.h / 2))
  expect(f.engine.selection.values()).toEqual([node.id])
  expect(focus).not.toHaveBeenCalled()
  f.frame()
  expect(focus).toHaveBeenCalledOnce()
  expect((focus.mock.calls[0]![0] as CustomEvent).detail).toBe(node.id)
  placeStartNode(f.engine, catalog, 'start-canvas')
  expect([...f.doc.elements()]).toHaveLength(1)
  expect(node.run).toBeUndefined()
})

it('短剧意图铺设真实模板与连线并提示，布局稳定后才进行第二次适配', () => {
  const f = setup()
  const view = f.engine.camera.viewRect
  queueStartNode('start-canvas', DRAMA_START)
  placeStartNode(f.engine, catalog, 'start-canvas')
  const selected = f.engine.selection.values()
  expect(selected).toHaveLength(2)
  expect(f.doc.worldRect(selected[0]!)).toMatchObject({ x: view.x + 80, y: view.y + 80 })
  for (const type of ['plein/storyboard', 'plein/sequence', 'plein/image', 'plein/video'])
    expect(
      [...f.doc.elements()].some((el) => el.nodeType === type),
      type,
    ).toBe(true)
  expect([...f.doc.edges()].length).toBeGreaterThan(0)
  expect(useCanvas.getState().notice).toContain('请到设置里启用')
  expect(f.engine.zoomToFit).toHaveBeenCalledOnce()
  f.frame()
  expect(f.engine.zoomToFit).toHaveBeenCalledOnce()
  f.frame()
  expect(f.engine.zoomToFit).toHaveBeenCalledTimes(2)
  expect([...f.doc.elements()].every((el) => !el.run && !el.results)).toBe(true)
})

it.each(['canvas', 'x', 'y', 'zoom', 'deleted'] as const)(
  '短剧首帧后 %s 改变，不让迟到适配打断当前操作',
  (change) => {
    const f = setup()
    queueStartNode('start-canvas', DRAMA_START)
    placeStartNode(f.engine, catalog, 'start-canvas')
    f.frame()
    if (change === 'canvas') useCanvas.setState({ engine: null, canvasId: 'other-canvas' })
    if (change === 'x') f.engine.camera.panBy(20, 0)
    if (change === 'y') f.engine.camera.panBy(0, 20)
    if (change === 'zoom') f.engine.camera.zoomAt(600, 400, 1.2)
    if (change === 'deleted') deleteElements(f.doc, f.engine.selection.values())
    f.frame()
    expect(f.engine.zoomToFit).toHaveBeenCalledOnce()
  },
)

it('无意图或节点目录中不存在的类型不落节点、不改变选择与视图', () => {
  const f = setup()
  placeStartNode(f.engine, catalog, 'start-canvas')
  queueStartNode('start-canvas', 'removed/node')
  placeStartNode(f.engine, catalog, 'start-canvas')
  expect([...f.doc.elements()]).toEqual([])
  expect(f.engine.selection.values()).toEqual([])
  expect(f.engine.zoomToFit).not.toHaveBeenCalled()
  expect(takeStartNode('start-canvas')).toBeUndefined()
})

import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, type PleinDoc, type NewElement } from '@plein/doc'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { compatibleNodes, handlePorts, placeElement, type NodeInfo } from './nodes'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function setup() {
  const doc = createDoc()
  docs.push(doc)
  const engine = {
    doc,
    selection: { set: vi.fn() },
    setTool: vi.fn(),
    camera: { viewRect: { x: -2000, y: -2000, w: 6000, h: 6000 }, centerOn: vi.fn() },
  } as unknown as Engine
  return { doc, engine }
}
const node = (kind: 'image' | 'video'): Omit<NewElement, 'x' | 'y'> => ({
  kind: 'node',
  nodeType: `plein/${kind}`,
  nodeVersion: 1,
  name: kind,
  w: 300,
  h: 200,
  params: { mode: 'text' },
  ports: {
    inputs: [
      { id: 'images', label: '图片', type: 'image', multiple: true },
      { id: 'videos', label: '视频', type: 'video', multiple: true },
    ],
    outputs:
      kind === 'image'
        ? [{ id: 'images', label: '图片', type: 'image' }]
        : [
            { id: 'video', label: '视频', type: 'video' },
            { id: 'lastFrame', label: '尾帧', type: 'image' },
          ],
  },
})

it.each(['image', 'video'] as const)(
  '从 %s 创建视频采用对应生成模式，节点和连接一步撤销重做',
  (kind) => {
    const { doc, engine } = setup()
    const source = createElement(doc, { ...node(kind), x: 0, y: 0 } as NewElement)
    const sourcePort = node(kind).ports!.outputs[0]!
    const id = placeElement(
      engine,
      node('video'),
      { x: 600, y: 200 },
      { elementId: source, side: 'out', port: sourcePort },
    )
    expect(doc.get(id)?.params?.mode).toBe(kind === 'image' ? 'image' : 'reference')
    const edges = [...doc.edges()]
    expect(edges.map((e) => [e.from, e.to])).toEqual([
      [
        [source, kind === 'image' ? 'images' : 'video'],
        [id, kind === 'image' ? 'images' : 'videos'],
      ],
    ])
    doc.undo.undo()
    expect([...doc.elements()].map((el) => el.id)).toEqual([source])
    expect([...doc.edges()]).toEqual([])
    doc.undo.redo()
    expect(doc.has(id)).toBe(true)
    expect([...doc.edges()]).toEqual(edges)
  },
)

it('共用连接点保留视频与尾帧候选，新建主视频连接优先主输出', () => {
  const { doc, engine } = setup()
  const source = createElement(doc, { ...node('video'), x: 0, y: 0 } as NewElement)
  const from = { elementId: source, side: 'out' as const, port: node('video').ports!.outputs[0]! }
  const ports = handlePorts(engine, from)
  expect(ports.map((p) => p.label)).toEqual(['视频', '尾帧'])
  const info = [
    { type: 'video', inputs: [{ type: 'video' }], outputs: [] },
    { type: 'image', inputs: [{ type: 'image' }], outputs: [] },
    { type: 'audio', inputs: [{ type: 'audio' }], outputs: [] },
  ] as unknown as NodeInfo[]
  expect(
    compatibleNodes(info, { side: 'out', types: ports.map((p) => p.type) }).map((n) => n.type),
  ).toEqual(['video', 'image'])
  const id = placeElement(engine, node('video'), { x: 600, y: 300 }, from)
  expect([...doc.edges()].map((e) => [e.from, e.to])).toEqual([
    [
      [source, 'video'],
      [id, 'videos'],
    ],
  ])
})

it('连续添加避让，避让到 Frame 外的卡片使用根层坐标', () => {
  const { doc, engine } = setup()
  const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 400, h: 300 })
  const first = placeElement(engine, node('image'), { x: 200, y: 150 })
  const second = placeElement(engine, node('image'), { x: 200, y: 150 })
  expect(doc.get(first)?.parentId).toBe(frame)
  expect(doc.get(second)?.parentId).toBeNull()
  const a = doc.worldRect(first)!,
    b = doc.worldRect(second)!
  expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).toBe(false)
  const snapshot = [...doc.elements()]
  doc.undo.undo()
  expect(doc.has(second)).toBe(false)
  expect(doc.has(first)).toBe(true)
  doc.undo.redo()
  expect([...doc.elements()]).toEqual(snapshot)
})

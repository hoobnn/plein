import { type Engine, Scene } from '@plein/canvas-core'
import { createElement, updateElement, type PleinDoc } from '@plein/doc'
import { openDoc, overlaps } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { deriveNode, freeSpotRight } from './presets'

const docs: PleinDoc[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const doc of docs.splice(0)) doc.destroy()
})
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const source = createElement(doc, {
    kind: 'image',
    assetId: 'source-image',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
  })
  return { doc, source }
}

it('场景索引尚未收录新卡片时，派生落点仍避让当前文档', () => {
  const { doc, source } = setup()
  const scene = new Scene(doc)
  const engine = { doc, scene } as unknown as Engine
  const first = freeSpotRight(engine, source, 100, 80)
  const added = createElement(doc, { kind: 'image', ...first, w: 100, h: 80 })
  expect(scene.has(added)).toBe(false)
  const next = freeSpotRight(engine, source, 100, 80)
  expect(overlaps(doc.worldRect(added)!, { ...next, w: 100, h: 80 })).toBe(false)
  expect(next).toEqual({ x: 180, y: 120 })
})

it('障碍移入目标区域而索引仍在旧位置时，使用新坐标避让', () => {
  const { doc, source } = setup()
  const obstacle = createElement(doc, { kind: 'image', x: 1000, y: 1000, w: 100, h: 80 })
  const scene = new Scene(doc)
  updateElement(doc, obstacle, { x: 180, y: 0 })
  expect(scene.rect(obstacle)?.x).toBe(1000)
  expect(freeSpotRight({ doc, scene } as unknown as Engine, source, 100, 80)).toEqual({
    x: 180,
    y: 120,
  })
})

it('父分组同帧移动时按子元素的新世界坐标避让，分组本身不挡住空位', () => {
  const { doc, source } = setup()
  const frame = createElement(doc, { kind: 'frame', x: 1000, y: 1000, w: 300, h: 300 })
  createElement(doc, { kind: 'image', parentId: frame, x: 0, y: 0, w: 100, h: 80 })
  const scene = new Scene(doc)
  updateElement(doc, frame, { x: 180, y: 0 })
  expect(freeSpotRight({ doc, scene } as unknown as Engine, source, 100, 80)).toEqual({
    x: 180,
    y: 120,
  })
})

it('删除障碍后不被旧索引占位，不改变已有卡片', () => {
  const { doc, source } = setup()
  const obstacle = createElement(doc, { kind: 'image', x: 180, y: 0, w: 100, h: 80 })
  const scene = new Scene(doc)
  doc.elementMaps.delete(obstacle)
  expect(scene.has(obstacle)).toBe(true)
  expect(freeSpotRight({ doc, scene } as unknown as Engine, source, 100, 80)).toEqual({
    x: 180,
    y: 0,
  })
  expect(doc.worldRect(source)).toEqual({ x: 0, y: 0, w: 100, h: 80 })
})

it('新来源尚未进入索引时也可连续派生并避让，连线保持来源且可逐步撤销重做', () => {
  const doc = openDoc()
  docs.push(doc)
  const scene = new Scene(doc)
  const source = createElement(doc, {
    kind: 'image',
    assetId: 'source-image',
    x: 0,
    y: 0,
    w: 100,
    h: 80,
  })
  expect(scene.has(source)).toBe(false)
  const engine = {
    doc,
    scene,
    selection: { set: vi.fn() },
    setTool: vi.fn(),
    camera: { viewRect: { x: -10000, y: -10000, w: 20000, h: 20000 }, centerOn: vi.fn() },
  } as unknown as Engine
  vi.stubGlobal('requestAnimationFrame', () => 0)
  const catalog = {
    nodes: [
      {
        type: 'test/video',
        version: 1,
        title: '测试视频',
        capability: 'video.generate',
        paramsSchema: { properties: {} },
        defaults: {},
        inputs: [{ id: 'images', type: 'image', label: '参考图', multiple: true }],
        outputs: [{ id: 'video', type: 'video', label: '视频' }],
      },
    ],
    prompts: [],
  } as never
  doc.undo.clear()
  const ids = Array.from({ length: 3 }, () => deriveNode(engine, catalog, source, 'test/video')!)
  const rects = ids.map((id) => doc.worldRect(id)!)
  expect(new Set(rects.map((r) => r.x)).size).toBe(1)
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false)
  for (const id of ids)
    expect([...doc.edges()]).toContainEqual(
      expect.objectContaining({ from: [source, 'image'], to: [id, 'images'] }),
    )
  expect(scene.has(ids[0]!)).toBe(false)
  doc.undo.undo()
  expect(doc.get(ids[2]!)).toBeUndefined()
  expect([...doc.edges()]).toHaveLength(2)
  doc.undo.redo()
  expect(ids.map((id) => doc.worldRect(id))).toEqual(rects)
  expect([...doc.edges()]).toHaveLength(3)
  expect(doc.worldRect(source)).toEqual({ x: 0, y: 0, w: 100, h: 80 })
})

it.each(['params', 'preset'] as const)(
  '%s 的最终竖屏画幅先参与派生避让，不在落位后扩大重叠',
  (mode) => {
    const { doc, source } = setup()
    const engine = {
      doc,
      scene: new Scene(doc),
      selection: { set: vi.fn() },
      setTool: vi.fn(),
      camera: { viewRect: { x: -10000, y: -10000, w: 20000, h: 20000 } },
    } as unknown as Engine
    vi.stubGlobal('requestAnimationFrame', () => 0)
    const node = {
      type: 'test/video',
      version: 1,
      title: '测试视频',
      defaults: { aspectRatio: '16:9' },
      paramsSchema: {
        properties: {
          prompt: { type: 'string', widget: 'textarea' },
          aspectRatio: { enum: ['16:9', '9:16'] },
        },
      },
      inputs: [{ id: 'images', type: 'image', label: '参考图', multiple: true }],
      outputs: [{ id: 'video', type: 'video', label: '视频' }],
    }
    const catalog = { nodes: [node], prompts: [] } as never
    const opts =
      mode === 'params'
        ? { params: { aspectRatio: '9:16' } }
        : {
            preset: {
              id: 'portrait',
              title: '竖屏预设',
              template: '竖屏水杯',
              params: { aspectRatio: '9:16' },
            } as never,
          }
    const ids = Array.from({ length: 3 }, () =>
      deriveNode(engine, catalog, source, 'test/video', opts)!,
    )
    const rects = ids.map((id) => doc.worldRect(id)!)
    for (const id of ids) {
      expect(doc.get(id)?.params?.aspectRatio).toBe('9:16')
      if (mode === 'preset') expect(doc.get(id)?.params?.prompt).toBe('竖屏水杯')
      expect(doc.worldRect(id)!.h).toBeGreaterThan(doc.worldRect(id)!.w)
    }
    expect(new Set(rects.map((r) => r.x)).size).toBe(1)
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i]!, rects[j]!)).toBe(false)
  },
)

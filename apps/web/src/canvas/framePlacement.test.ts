import { type Engine, Scene } from '@plein/canvas-core'
import { bringToFront, createElement, updateElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { containingFrame, placeElement } from './nodes'
import { placeImports } from './import'

const docs: PleinDoc[] = []
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy()
})
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 1000, h: 800 })
  const scene = new Scene(doc)
  return {
    doc,
    frame,
    scene,
    engine: {
      doc,
      scene,
      selection: { set: vi.fn() },
      setTool: vi.fn(),
      camera: { viewRect: { x: -10000, y: -10000, w: 20000, h: 20000 } },
    } as unknown as Engine,
  }
}
const inside = { x: 100, y: 100, w: 100, h: 80 }

it('新建分组尚未进入场景索引时也能接纳卡片', () => {
  const { doc, engine, scene } = setup()
  const frame = createElement(doc, { kind: 'frame', x: 2000, y: 0, w: 1000, h: 800 })
  expect(scene.has(frame)).toBe(false)
  expect(containingFrame(engine, { ...inside, x: 2100 })).toBe(frame)
})
it('分组同帧移入时使用当前位置归组，移走后旧位置不再接纳', () => {
  const { doc, engine, frame } = setup()
  updateElement(doc, frame, { x: 2000 })
  expect(containingFrame(engine, { ...inside, x: 2100 })).toBe(frame)
  expect(containingFrame(engine, inside)).toBeNull()
})
it('已删除但仍在旧索引中的分组不参与归组', () => {
  const { doc, engine, frame } = setup()
  doc.elementMaps.delete(frame)
  expect(containingFrame(engine, inside)).toBeNull()
})
it('同帧调整重叠分组层级后，选择当前最上层完整容纳的分组', () => {
  const { doc, engine, frame } = setup()
  const upper = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 1000, h: 800 })
  expect(containingFrame(engine, inside)).toBe(upper)
  bringToFront(doc, [frame])
  expect(containingFrame(engine, inside)).toBe(frame)
})
it('嵌套分组按当前父级世界坐标归组，只有完全容纳才接纳', () => {
  const { doc, engine, frame } = setup()
  const inner = createElement(doc, { kind: 'frame', parentId: frame, x: 50, y: 50, w: 200, h: 200 })
  updateElement(doc, frame, { x: 2000, y: 1000 })
  expect(containingFrame(engine, { ...inside, x: 2100, y: 1100 })).toBe(inner)
  expect(containingFrame(engine, { ...inside, x: 2200, y: 1100 })).toBe(frame)
  expect(containingFrame(engine, { ...inside, x: 2950, y: 1100 })).toBeNull()
})
it.each(['node', 'import'] as const)('%s 在分组移动后保留落点和归属，撤销重做不跳位', (mode) => {
  const { doc, engine, frame, scene } = setup()
  updateElement(doc, frame, { x: 2000, y: 1000 })
  expect(scene.rect(frame)!.x).toBe(0)
  doc.undo.stopCapturing()
  const input = { kind: 'image' as const, assetId: 'local-image', w: 100, h: 80 }
  const id =
    mode === 'node'
      ? placeElement(engine, input, { x: 2150, y: 1140 })
      : placeImports(engine, [{ ...input, x: 2100, y: 1100 }])[0]!
  expect(doc.get(id)?.parentId).toBe(frame)
  expect(doc.get(id)).toMatchObject({ x: 100, y: 100 })
  expect(doc.worldRect(id)).toEqual({ x: 2100, y: 1100, w: 100, h: 80 })
  doc.undo.undo()
  expect(doc.get(id)).toBeUndefined()
  doc.undo.redo()
  expect(doc.get(id)?.parentId).toBe(frame)
  expect(doc.worldRect(id)).toEqual({ x: 2100, y: 1100, w: 100, h: 80 })
})

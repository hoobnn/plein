import { type Engine, Scene } from '@plein/canvas-core'
import { createElement, type PleinDoc, updateElement } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { startRegionEdit } from './regionEdit'

const docs: PleinDoc[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  docs.splice(0).forEach((doc) => doc.destroy())
})
const catalog = {
  nodes: [
    {
      type: 'plein/image-edit',
      version: 1,
      title: '局部重绘',
      capability: 'image.edit',
      paramsSchema: { properties: { mask: {} } },
      defaults: { mask: null },
      inputs: [{ id: 'image', type: 'image', label: '原图' }],
      outputs: [{ id: 'images', type: 'image', label: '图片' }],
    },
  ],
  providers: [],
  prompts: [],
} as unknown as Catalog
const mask = { assetId: 'mask', sourceAssetId: 'source', width: 160, height: 96 }
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const source = createElement(doc, { kind: 'image', assetId: 'source', x: 0, y: 0, w: 160, h: 96 })
  const engine = {
    doc,
    scene: new Scene(doc),
    selection: { set: vi.fn() },
    setTool: vi.fn(),
    camera: { viewRect: { x: -10000, y: -10000, w: 20000, h: 20000 }, centerOn: vi.fn() },
  } as unknown as Engine
  vi.stubGlobal('requestAnimationFrame', () => 0)
  return { doc, source, engine }
}
for (const change of ['replace', 'delete', 'readonly'] as const) {
  it(`新建重绘保存前 ${change} 不创建节点或写入撤销历史`, () => {
    const { doc, source, engine } = setup()
    if (change === 'replace') updateElement(doc, source, { assetId: 'replacement' })
    if (change === 'delete') doc.elementMaps.delete(source)
    if (change === 'readonly') doc.readOnly = true
    const before = [...doc.elements()]
    const history = doc.undo.undoStack.length
    expect(() => startRegionEdit(engine, catalog, source, mask, '原图')).toThrow()
    expect([...doc.elements()]).toEqual(before)
    expect(doc.undo.undoStack.length).toBe(history)
  })
}
it('保存创建一份连好原图、比例正确的草稿，不触发生成', () => {
  const { doc, source, engine } = setup()
  const id = startRegionEdit(engine, catalog, source, mask, '原图')!
  const created = doc.get(id)!
  expect(created.params!.mask).toEqual(mask)
  expect(created.w / created.h).toBeCloseTo(160 / 96, 1)
  expect(created.run).toBeUndefined()
  expect(created.results).toBeUndefined()
  expect([...doc.edges()]).toEqual([
    expect.objectContaining({ from: [source, 'image'], to: [id, 'image'] }),
  ])
})

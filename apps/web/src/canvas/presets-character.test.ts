import { type Engine, Scene } from '@plein/canvas-core'
import { addResults, adoptResult, createElement, updateElement, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { nodeElement } from './nodes'
import { deriveNode } from './presets'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const target = { libraryId: 'original-role', slot: 'portrait' }
const catalog = {
  nodes: corePlugin.nodes.map((node) => ({
    ...describeNode(node, 'plein/core'),
    executable: true,
  })),
  prompts: [],
  providers: [],
} as unknown as Catalog
const docs: PleinDoc[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const doc of docs.splice(0)) doc.destroy()
})
function setup() {
  const doc = openDoc()
  docs.push(doc)
  const info = catalog.nodes.find((node) => node.type === 'plein/image')!
  const source = createElement(doc, {
    ...nodeElement(info),
    x: 0,
    y: 0,
    params: { characterAssetTarget: target },
  })
  addResults(doc, source, [
    {
      id: 'adopted',
      runId: 'fixture',
      at: 1,
      port: 'images',
      value: { type: 'image', assetId: A },
    },
    {
      id: 'unadopted',
      runId: 'fixture',
      at: 2,
      port: 'images',
      value: { type: 'image', assetId: B },
    },
  ])
  adoptResult(doc, source, 'adopted')
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

it.each(['plein/image', 'plein/image-edit', 'plein/image-process'])(
  '明确采用的角色图派生为 %s 时保留目标，且只建草稿',
  (type) => {
    const { doc, source, engine } = setup()
    const id = deriveNode(engine, catalog, source, type, { sourceAssetId: A })!
    expect(doc.get(id)?.params?.characterAssetTarget).toEqual(target)
    expect(doc.get(id)?.results ?? []).toHaveLength(0)
    expect([...doc.edges()]).toContainEqual(
      expect.objectContaining({
        from: [source, 'images'],
        to: [id, type === 'plein/image' ? 'references' : 'image'],
      }),
    )
    doc.undo.undo()
    expect(doc.get(id)).toBeUndefined()
    doc.undo.redo()
    expect(doc.get(id)?.params?.characterAssetTarget).toEqual(target)
  },
)
it('不把角色绑定传播到视频或插件图片节点', () => {
  const { doc, source, engine } = setup()
  const video = deriveNode(engine, catalog, source, 'plein/video', { sourceAssetId: A })!
  expect(doc.get(video)?.params?.characterAssetTarget).toBeUndefined()
  const custom = {
    ...catalog.nodes.find((node) => node.type === 'plein/image-process')!,
    type: 'other/image-process',
  }
  const id = deriveNode(
    engine,
    { ...catalog, nodes: [...catalog.nodes, custom] },
    source,
    custom.type,
    { sourceAssetId: A },
  )!
  expect(doc.get(id)?.params?.characterAssetTarget).toBeUndefined()
})
it('普通图片即使有同一文件和误留目标字段，也不推断角色归属', () => {
  const { doc, engine } = setup()
  const image = createElement(doc, {
    kind: 'image',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    assetId: A,
    params: { characterAssetTarget: target },
  })
  const id = deriveNode(engine, catalog, image, 'plein/image-process', { sourceAssetId: A })!
  expect(doc.get(id)?.params?.characterAssetTarget).toBeUndefined()
})
it('来源采用项不一致或请求另一角色时，不派生或静默改绑', () => {
  const { doc, source, engine } = setup()
  const count = [...doc.elements()].length
  expect(deriveNode(engine, catalog, source, 'plein/image-edit', { sourceAssetId: B })).toBeNull()
  expect(
    deriveNode(engine, catalog, source, 'plein/image-process', {
      sourceAssetId: A,
      params: { characterAssetTarget: { ...target, libraryId: 'another-role' } },
    }),
  ).toBeNull()
  expect([...doc.elements()]).toHaveLength(count)
  updateElement(doc, source, { locked: true })
  expect(
    deriveNode(engine, catalog, source, 'plein/image-process', { sourceAssetId: A }),
  ).toBeNull()
  expect([...doc.elements()]).toHaveLength(count)
})

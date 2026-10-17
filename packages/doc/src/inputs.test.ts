import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import {
  connect,
  createDoc,
  createElement,
  duplicateElements,
  inputEdges,
  moveElements,
  reorderInputs,
  replaceInput,
  SCHEMA_VERSION,
} from './index'
import { box, node, openDoc } from './testing'

const target = (doc: ReturnType<typeof openDoc>) =>
  createElement(
    doc,
    node({
      name: '生成器',
      ports: {
        inputs: [{ id: 'images', type: 'image', label: '图片', multiple: true }],
        outputs: [],
      },
    }),
  )

describe('稳定输入顺序', () => {
  it('按连入顺序追加，移动源节点不改变输入；显式排序可独立撤销', () => {
    const doc = openDoc()
    const a = createElement(doc, box({ assetId: 'test-image', y: 400 }))
    const b = createElement(doc, box({ assetId: 'test-image', y: -400 }))
    const t = target(doc)
    const ea = connect(doc, [a, 'image'], [t, 'images'])!
    const eb = connect(doc, [b, 'image'], [t, 'images'])!
    expect(inputEdges(doc, t).map((e) => e.id)).toEqual([ea.id, eb.id])
    moveElements(doc, [a], 900, -1000)
    expect(inputEdges(doc, t).map((e) => e.id)).toEqual([ea.id, eb.id])
    doc.undo.stopCapturing()
    expect(reorderInputs(doc, [t, 'images'], [eb.id, ea.id])).toBe(true)
    doc.undo.stopCapturing()
    expect(inputEdges(doc, t).map((e) => e.id)).toEqual([eb.id, ea.id])
    doc.undo.undo()
    expect(inputEdges(doc, t).map((e) => e.id)).toEqual([ea.id, eb.id])
    doc.undo.redo()
    expect(inputEdges(doc, t).map((e) => e.id)).toEqual([eb.id, ea.id])
  })

  it('拒绝缺项、重复、不同端口的排序，拒绝不兼容或重复的替换', () => {
    const doc = openDoc()
    const a = createElement(doc, box({ assetId: 'test-image' }))
    const b = createElement(doc, box({ assetId: 'test-image' }))
    const c = createElement(doc, node())
    const t = target(doc)
    const ea = connect(doc, [a, 'image'], [t, 'images'])!
    const eb = connect(doc, [b, 'image'], [t, 'images'])!
    expect(reorderInputs(doc, [t, 'images'], [ea.id])).toBe(false)
    expect(reorderInputs(doc, [t, 'images'], [ea.id, ea.id])).toBe(false)
    expect(reorderInputs(doc, [t, 'other'], [eb.id, ea.id])).toBe(false)
    expect(replaceInput(doc, ea.id, [c, 'out'])).toBe(false)
    expect(replaceInput(doc, ea.id, [b, 'image'])).toBe(false)
  })

  it('替换保留槽位和边身份，复制粘贴保留语义顺序', () => {
    const doc = openDoc()
    const a = createElement(doc, box({ assetId: 'test-image', name: 'a' }))
    const b = createElement(doc, box({ assetId: 'test-image', name: 'b' }))
    const c = createElement(doc, box({ assetId: 'test-image', name: 'c' }))
    const t = target(doc)
    const ea = connect(doc, [a, 'image'], [t, 'images'])!
    connect(doc, [b, 'image'], [t, 'images'])
    expect(replaceInput(doc, ea.id, [c, 'image'])).toBe(true)
    expect(doc.getEdge(ea.id)).toMatchObject({ order: ea.order, from: [c, 'image'] })
    expect(doc.has(a)).toBe(true)
    const copy = duplicateElements(doc, [b, c, t])
    const copied = copy.find((id) => doc.get(id)?.name === '生成器')!
    expect(inputEdges(doc, copied).map((e) => doc.get(e.from[0])?.name)).toEqual(['c', 'b'])
  })

  it('v2 升级以世界坐标固化顺序，迁移不进入撤销栈', () => {
    const initial = openDoc()
    const a = createElement(initial, box({ assetId: 'test-image', y: 400 }))
    const b = createElement(initial, box({ assetId: 'test-image', y: -400 }))
    const t = target(initial)
    connect(initial, [a, 'image'], [t, 'images'])
    connect(initial, [b, 'image'], [t, 'images'])
    for (const [id, e] of initial.edgeMap) initial.edgeMap.set(id, { id, from: e.from, to: e.to })
    initial.meta.set('schemaVersion', 2)
    const encoded = Y.encodeStateAsUpdate(initial.ydoc)
    const raw = new Y.Doc()
    Y.applyUpdate(raw, encoded)
    const migrated = createDoc(raw)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(inputEdges(migrated, t).map((e) => e.from[0])).toEqual([b, a])
    expect(migrated.undo.undoStack).toHaveLength(0)
    moveElements(migrated, [a], 0, -2000)
    expect(inputEdges(migrated, t).map((e) => e.from[0])).toEqual([b, a])
  })

  it('并发追加相同 rank 时，各端按边 ID 得到相同顺序', () => {
    const a = openDoc()
    const s1 = createElement(a, box({ assetId: 'test-image' }))
    const s2 = createElement(a, box({ assetId: 'test-image' }))
    const t = target(a)
    const b = openDoc()
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc))
    connect(a, [s1, 'image'], [t, 'images'])
    connect(b, [s2, 'image'], [t, 'images'])
    const ua = Y.encodeStateAsUpdate(a.ydoc)
    const ub = Y.encodeStateAsUpdate(b.ydoc)
    Y.applyUpdate(a.ydoc, ub)
    Y.applyUpdate(b.ydoc, ua)
    expect(inputEdges(a, t)).toEqual(inputEdges(b, t))
    expect(inputEdges(a, t)).toHaveLength(2)
  })
})

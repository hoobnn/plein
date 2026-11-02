import { expect, it } from 'vite-plus/test'
import * as Y from 'yjs'

import { connect, createElement, deleteElements, removeEdges, setParams } from './index'
import { openDoc } from './testing'

function fixture() {
  const doc = openDoc()
  const source = createElement(doc, {
    kind: 'image',
    name: '来源.png',
    assetId: 'a',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const other = createElement(doc, {
    kind: 'image',
    name: '其他.png',
    assetId: 'b',
    x: 200,
    y: 0,
    w: 100,
    h: 100,
  })
  const target = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    ports: {
      inputs: [{ id: 'images', label: '图片', type: 'image', multiple: true }],
      outputs: [],
    },
    params: {},
    x: 0,
    y: 300,
    w: 200,
    h: 100,
  })
  const nameKey = `referenceNameBinding:${encodeURIComponent('来源.png')}:${source}`
  const otherKey = `referenceNameBinding:${encodeURIComponent('其他.png')}:${other}`
  setParams(doc, target, {
    [nameKey]: { type: 'image', assetId: 'a', source },
    'referenceBinding:image1:old:a': { type: 'image', assetId: 'a', source },
    referenceBindings: {
      image2: { type: 'image', assetId: 'a', source },
      image3: { type: 'image', assetId: 'b', source: other },
    },
    [otherKey]: { type: 'image', assetId: 'b', source: other },
    'referenceNameBinding:%E5%8E%86%E5%8F%B2.png:history': null,
  })
  const edge = connect(doc, [source, 'image'], [target, 'images'])!
  // 前面的搭建单独成一步，撤销时只回退这次操作。
  doc.undo.stopCapturing()
  return { doc, source, other, target, edge, nameKey, otherKey }
}

it('移除连线清理该来源绑定，但保留必需引用、选图和其他绑定', () => {
  const f = fixture()
  setParams(f.doc, f.target, {
    requiredRefs: [f.source, f.other],
    referenceImagePicks: { [f.source]: ['asset-a'], [f.other]: ['asset-b'] },
  })
  f.doc.undo.stopCapturing()
  removeEdges(f.doc, [f.edge.id])
  const params = f.doc.get(f.target)?.params
  expect(params).not.toHaveProperty(f.nameKey)
  expect(params).not.toHaveProperty('referenceBinding:image1:old:a')
  expect(params?.referenceBindings).toEqual({
    image3: { type: 'image', assetId: 'b', source: f.other },
  })
  expect(params).toHaveProperty(f.otherKey)
  expect(params).toHaveProperty('referenceNameBinding:%E5%8E%86%E5%8F%B2.png:history', null)
  expect(params?.requiredRefs).toEqual([f.source, f.other])
  expect(params?.referenceImagePicks).toEqual({
    [f.source]: ['asset-a'],
    [f.other]: ['asset-b'],
  })

  f.doc.undo.undo()
  expect(f.doc.get(f.target)?.params).toHaveProperty(f.nameKey)
  expect(f.doc.get(f.target)?.params?.requiredRefs).toEqual([f.source, f.other])
  expect(f.doc.get(f.target)?.params?.referenceImagePicks).toEqual({
    [f.source]: ['asset-a'],
    [f.other]: ['asset-b'],
  })
  expect(f.doc.get(f.target)?.params?.referenceBindings).toHaveProperty('image2')
  expect([...f.doc.edges()]).toHaveLength(1)
  f.doc.destroy()
})

it('删除元素清理所有节点指向它的绑定（含历史 null），撤销恢复', () => {
  const f = fixture()
  setParams(f.doc, f.target, {
    [`referenceNameBinding:null:${f.source}`]: null,
  })
  f.doc.undo.stopCapturing()
  deleteElements(f.doc, [f.source])
  const params = f.doc.get(f.target)?.params
  expect(params).not.toHaveProperty(f.nameKey)
  expect(params).not.toHaveProperty(`referenceNameBinding:null:${f.source}`)
  expect(params).not.toHaveProperty('referenceBinding:image1:old:a')
  expect(params?.referenceBindings).toEqual({
    image3: { type: 'image', assetId: 'b', source: f.other },
  })
  expect(params).toHaveProperty(f.otherKey)

  f.doc.undo.undo()
  expect(f.doc.has(f.source)).toBe(true)
  expect(f.doc.get(f.target)?.params).toHaveProperty(f.nameKey)
  expect(f.doc.get(f.target)?.params).toHaveProperty(`referenceNameBinding:null:${f.source}`, null)
  f.doc.destroy()
})

it('删除元素保留必需引用和选图，旧普通对象不会迁移成 Yjs 子 Map', () => {
  const f = fixture()
  setParams(f.doc, f.target, {
    requiredRefs: [f.source, f.other, 'external'],
    referenceImagePicks: { [f.source]: ['asset-a'], [f.other]: ['asset-b'] },
  })
  const params = f.doc.mutable(f.target)!.get('params') as Y.Map<unknown>
  const picks = params.get('referenceImagePicks')
  f.doc.undo.stopCapturing()

  deleteElements(f.doc, [f.source])
  expect(f.doc.get(f.target)?.params?.requiredRefs).toEqual([f.source, f.other, 'external'])
  expect(f.doc.get(f.target)?.params?.referenceImagePicks).toEqual({
    [f.source]: ['asset-a'],
    [f.other]: ['asset-b'],
  })
  expect(params.get('referenceImagePicks')).toBe(picks)
  expect(params.get('referenceImagePicks')).not.toBeInstanceOf(Y.Map)
  f.doc.destroy()
})

it('删除元素时只清理指向它的绑定，其它节点的绑定不受影响', () => {
  const f = fixture()
  const other = createElement(f.doc, {
    kind: 'image',
    name: '第三个.png',
    assetId: 'c',
    x: 400,
    y: 0,
    w: 100,
    h: 100,
  })
  setParams(f.doc, f.target, {
    [`referenceNameBinding:${encodeURIComponent('第三个.png')}:${other}`]: {
      type: 'image',
      assetId: 'c',
      source: other,
    },
  })
  f.doc.undo.stopCapturing()
  deleteElements(f.doc, [f.other])
  const params = f.doc.get(f.target)?.params
  expect(params).not.toHaveProperty(f.otherKey)
  expect(params).toHaveProperty(`referenceNameBinding:${encodeURIComponent('第三个.png')}:${other}`)
  f.doc.destroy()
})

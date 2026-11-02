import { connect, createElement, inputEdges, replaceInput, setParam } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { referenceBindings, resolveReferenceBindings } from '@plein/plugin-sdk'
import { expect, it } from 'vite-plus/test'
import { bindReferenceName, migrateReferenceNames, replaceReferenceName } from './referenceNames'

it('旧编号转换为当前图片名，移除已替换素材的重复旧引用，转换后仍可解析', () => {
  const doc = openDoc()
  try {
    const source = createElement(doc, {
      kind: 'image',
      name: '产品截图.png',
      assetId: 'new',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      params: {
        prompt: '@image2 保持构图 @image1 @image1 @image1',
        referenceBindings: {
          image1: { type: 'image', assetId: 'deleted', source: 'removed-source' },
          image2: { type: 'image', assetId: 'old-result', source },
        },
      },
    })
    const current = [{ type: 'image' as const, assetId: 'new', source }]
    migrateReferenceNames(doc, id, current)
    const saved = doc.get(id)!
    expect(saved.params?.prompt).toBe('@产品截图.png 保持构图   ')
    expect(resolveReferenceBindings(String(saved.params?.prompt), current, saved.params)).toEqual({
      prompt: '@image1 保持构图   ',
    })
    const version = doc.ydoc.store.clients.size
    migrateReferenceNames(doc, id, current)
    expect(doc.get(id)!.params).toEqual(saved.params)
    expect(doc.ydoc.store.clients.size).toBe(version)
  } finally {
    doc.destroy()
  }
})

it('替换参考图时同时更新普通名称与旧编号，连线和正文一起撤销', () => {
  const doc = openDoc()
  try {
    const image = (name: string, assetId: string) =>
      createElement(doc, { kind: 'image', name, assetId, x: 0, y: 0, w: 100, h: 100 })
    const old = image('旧图.png', 'old')
    const next = image('新图.png', 'new')
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      ports: {
        inputs: [{ id: 'images', label: '图片', type: 'image', multiple: true }],
        outputs: [],
      },
      params: {
        prompt: '@旧图.png @image1',
        requiredRefs: [old, 'external'],
        referenceImagePicks: { [old]: ['old'], external: ['external'] },
        referenceBindings: { image1: { type: 'image', assetId: 'old', source: old } },
      },
    })
    connect(doc, [old, 'image'], [id, 'images'])
    doc.flush()
    doc.undo.stopCapturing()
    const edge = inputEdges(doc, id, 'images')[0]!
    expect(replaceInput(doc, edge.id, [next, 'image'])).toBe(true)
    replaceReferenceName(doc, id, old, { type: 'image', assetId: 'new', source: next })
    doc.undo.stopCapturing()
    doc.flush()
    expect(doc.get(id)!.params?.prompt).toBe('@新图.png @新图.png')
    expect(referenceBindings(doc.get(id)!.params)['新图.png']?.source).toBe(next)
    expect(doc.get(id)!.params?.requiredRefs).toEqual([old, 'external'])
    expect(doc.get(id)!.params?.referenceImagePicks).toEqual({
      [old]: ['old'],
      external: ['external'],
    })
    doc.undo.undo()
    doc.flush()
    expect(inputEdges(doc, id, 'images')[0]!.from[0]).toBe(old)
    expect(doc.get(id)!.params?.prompt).toBe('@旧图.png @image1')
    expect(doc.get(id)!.params?.requiredRefs).toEqual([old, 'external'])
    expect(doc.get(id)!.params?.referenceImagePicks).toEqual({
      [old]: ['old'],
      external: ['external'],
    })
  } finally {
    doc.destroy()
  }
})

it('名称重复时消歧，未知旧编号和协作冲突不擅自改写', () => {
  const doc = openDoc()
  try {
    const sources = ['a', 'b']
      .map((assetId) =>
        createElement(doc, {
          kind: 'image',
          name: '产品.png',
          assetId,
          x: 0,
          y: 0,
          w: 100,
          h: 100,
        }),
      )
      .sort()
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/video',
      params: { prompt: '@image1' },
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    expect(bindReferenceName(doc, id, { type: 'image', assetId: 'b', source: sources[1] })).toBe(
      '产品.png#2',
    )
    migrateReferenceNames(doc, id, [])
    expect(doc.get(id)!.params?.prompt).toBe('@image1')
    setParam(doc, id, 'referenceBindings', {
      'image1:a': { type: 'image', assetId: 'a', source: sources[0] },
      'image1:b': { type: 'image', assetId: 'b', source: sources[1] },
    })
    migrateReferenceNames(doc, id, [])
    expect(doc.get(id)!.params?.prompt).toBe('@image1')
  } finally {
    doc.destroy()
  }
})

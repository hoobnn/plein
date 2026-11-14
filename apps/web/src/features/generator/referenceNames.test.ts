import { connect, createElement, inputEdges, replaceInput, setParam } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { referenceBindings, resolveReferenceBindings } from '@plein/plugin-sdk'
import { expect, it } from 'vite-plus/test'
import {
  bindReferenceName,
  migrateReferenceNames,
  referenceName,
  replaceReferenceName,
} from './referenceNames'

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

it('同一视频节点的视频与尾帧使用不同别名绑定，替换一边不影响另一边', () => {
  const doc = openDoc()
  try {
    const source = createElement(
      doc,
      node({
        id: 'g',
        name: '片段',
        nodeType: 'plein/video',
        ports: {
          inputs: [],
          outputs: [
            { id: 'video', label: '视频', type: 'video' },
            { id: 'lastFrame', label: '尾帧', type: 'image' },
          ],
        },
      }),
    )
    const video = { type: 'video' as const, assetId: 'vid', source, sourcePort: 'video' }
    const frame = { type: 'image' as const, assetId: 'frame', source, sourcePort: 'lastFrame' }
    expect(referenceName(doc, video)).toBe('片段')
    expect(referenceName(doc, frame)).toBe('片段·尾帧')

    const target = createElement(
      doc,
      node({
        id: 't',
        nodeType: 'plein/video',
        params: { prompt: '@片段 推近，停在 @片段·尾帧' },
      }),
    )
    bindReferenceName(doc, target, video)
    bindReferenceName(doc, target, frame)
    expect(referenceBindings(doc.get(target)!.params)).toMatchObject({
      片段: { type: 'video', sourcePort: 'video', source },
      片段·尾帧: { type: 'image', sourcePort: 'lastFrame', source },
    })

    // 反向插入顺序不改别名，两个输出口不会互相覆盖绑定。
    const reverse = createElement(doc, node({ id: 'r', nodeType: 'plein/video' }))
    bindReferenceName(doc, reverse, frame)
    bindReferenceName(doc, reverse, video)
    expect(Object.keys(referenceBindings(doc.get(reverse)!.params)).sort()).toEqual(
      ['片段', '片段·尾帧'].sort(),
    )

    const next = createElement(doc, {
      kind: 'image',
      id: 'new',
      name: '新图',
      assetId: 'new-asset',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    replaceReferenceName(
      doc,
      target,
      source,
      { type: 'image', assetId: 'new-asset', source: next },
      'lastFrame',
    )
    const params = doc.get(target)!.params!
    expect(params.prompt).toBe('@片段 推近，停在 @新图')
    expect(params).toHaveProperty(`referenceNameBinding:${encodeURIComponent('片段')}:${source}`)
    expect(params).not.toHaveProperty(
      `referenceNameBinding:${encodeURIComponent('片段·尾帧')}:${source}`,
    )
    expect(params).toHaveProperty(`referenceNameBinding:${encodeURIComponent('新图')}:${next}`)
  } finally {
    doc.destroy()
  }
})

it('替换成还没生成的新来源也同步正文与绑定，生成后只用新来源', () => {
  const doc = openDoc()
  try {
    const old = createElement(doc, {
      kind: 'image',
      id: 'old',
      name: '旧图',
      assetId: 'old-asset',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const next = createElement(doc, node({ id: 'next', name: '新图', nodeType: 'plein/image' }))
    const target = createElement(
      doc,
      node({
        params: {
          prompt: '@旧图 保持构图',
          [`referenceNameBinding:${encodeURIComponent('旧图')}:${old}`]: {
            type: 'image',
            assetId: 'old-asset',
            source: old,
            sourcePort: 'image',
          },
        },
      }),
    )
    replaceReferenceName(doc, target, old, { type: 'image', assetId: '', source: next }, 'image')
    const params = doc.get(target)!.params!
    expect(params.prompt).toBe('@新图 保持构图')
    expect(params).not.toHaveProperty(`referenceNameBinding:${encodeURIComponent('旧图')}:${old}`)
    expect(referenceBindings(params)).toEqual({
      新图: { type: 'image', assetId: '', source: next },
    })
    // 新来源生成后才按它的结果编号，不会退回旧图。
    expect(
      resolveReferenceBindings(
        '@新图 保持构图',
        [{ type: 'image', assetId: 'fresh', source: next }],
        params,
      ),
    ).toEqual({ prompt: '@image1 保持构图' })
  } finally {
    doc.destroy()
  }
})

it('端口别名和另一素材的真实名称撞车时仍可同时引用', () => {
  const doc = openDoc()
  try {
    const clip = createElement(
      doc,
      node({
        id: 'clip',
        name: '镜头',
        nodeType: 'plein/video',
        ports: {
          inputs: [],
          outputs: [
            { id: 'video', label: '视频', type: 'video' },
            { id: 'lastFrame', label: '尾帧', type: 'image' },
          ],
        },
      }),
    )
    const frameElement = createElement(doc, {
      kind: 'image',
      id: 'frame-el',
      name: '镜头·尾帧',
      assetId: 'frame-asset',
      x: 200,
      y: 0,
      w: 100,
      h: 100,
    })
    const tail = {
      type: 'image' as const,
      assetId: 'tail-asset',
      source: clip,
      sourcePort: 'lastFrame',
    }
    expect(
      referenceName(doc, {
        type: 'image',
        assetId: 'frame-asset',
        source: frameElement,
        sourcePort: 'image',
      }),
    ).toBe('镜头·尾帧')
    expect(referenceName(doc, tail)).toBe('镜头·尾帧#2')
    expect(referenceName(doc, tail)).not.toBe(
      referenceName(doc, {
        type: 'image',
        assetId: 'frame-asset',
        source: frameElement,
        sourcePort: 'image',
      }),
    )
    const target = createElement(doc, node({ id: 'target', nodeType: 'plein/video' }))
    bindReferenceName(doc, target, tail)
    bindReferenceName(doc, target, {
      type: 'image',
      assetId: 'frame-asset',
      source: frameElement,
      sourcePort: 'image',
    })
    expect(referenceBindings(doc.get(target)!.params)).toMatchObject({
      '镜头·尾帧#2': { source: clip, sourcePort: 'lastFrame' },
      镜头·尾帧: { source: frameElement },
    })
  } finally {
    doc.destroy()
  }
})

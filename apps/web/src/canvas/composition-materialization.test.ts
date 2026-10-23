import type { Engine } from '@plein/canvas-core'
import { connect, createDoc, createElement } from '@plein/doc'
import { arrangeSequence, sequenceNode, sequenceSpec } from '@plein/nodes'
import type { PortValue } from '@plein/plugin-sdk'
import type { Asset, Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { elementFor } from './import'
import { upstreams } from './nodes'

const source = {
  version: 1 as const,
  bundleAssetId: 'a'.repeat(64),
  manifestAssetId: 'b'.repeat(64),
  dependencyAssetIds: ['c'.repeat(64)],
  rendererIdentity: 'hyperframes:fixture',
}
const asset: Asset = {
  id: 'd'.repeat(64),
  kind: 'video',
  mime: 'video/mp4',
  name: '动态合成.mp4',
  size: 100,
  width: 1080,
  height: 1920,
  duration: 2,
  variants: [],
  createdAt: 1,
}

describe('动态合成结果素材化的来源', () => {
  it('历史候选转为普通视频后，经普通上游到序列工程仍携带同一个冻结源', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    try {
      const materialized = elementFor(asset, source)!
      expect(materialized.params?.compositionSource).toEqual(source)
      const video = createElement(doc, { ...materialized, x: 0, y: 0 })
      const sequence = createElement(doc, {
        kind: 'node',
        nodeType: 'plein/sequence',
        x: 500,
        y: 0,
        w: 320,
        h: 240,
        ports: {
          inputs: [{ id: 'clips', label: '镜头', type: 'video', multiple: true }],
          outputs: [{ id: 'video', label: '成片', type: 'video' }],
        },
      })
      connect(doc, [video, 'video'], [sequence, 'clips'])
      const value = upstreams({ doc } as unknown as Engine, sequence, {
        nodes: [],
      } as unknown as Catalog).get('clips')![0]!.value!
      expect(value).toMatchObject({ type: 'video', assetId: asset.id, compositionSource: source })
      const params = sequenceNode.params.parse({ subtitles: false })
      const inputs = { clips: [{ ...value, kind: 'video', source: video } as PortValue] }
      const arranged = arrangeSequence(params, inputs)
      const spec = sequenceSpec(params, arranged, { clips: [2], dialogue: [], more: [] }, undefined)
      expect(spec.clips[0]!.asset.compositionSource).toEqual(source)
    } finally {
      doc.destroy()
    }
  })

  it('不向普通媒体参数或下游传递未通过 schema 的来源', () => {
    expect(elementFor(asset, { ...source, bundleAssetId: '../unsafe' })?.params).toBeUndefined()
    const doc = createDoc(undefined, { schedule: () => {} })
    try {
      const image = createElement(doc, {
        kind: 'image',
        assetId: asset.id,
        params: { compositionSource: { ...source, version: 99 } },
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      })
      const target = createElement(doc, {
        kind: 'node',
        x: 400,
        y: 0,
        w: 100,
        h: 100,
        ports: { inputs: [{ id: 'image', label: '图片', type: 'image' }], outputs: [] },
      })
      connect(doc, [image, 'image'], [target, 'image'])
      expect(upstreams({ doc } as unknown as Engine, target, null).get('image')![0]!.value).toEqual(
        { type: 'image', assetId: asset.id },
      )
    } finally {
      doc.destroy()
    }
  })
})

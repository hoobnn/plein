import { createDoc, createElement, setParams } from '@plein/doc'
import { videoNode } from '@plein/nodes'
import { expect, it } from 'vite-plus/test'
import { continuationInputs } from './continuation-inputs'

it('无接续帧时阻断；前镜更新时不悄悄沿用旧尾帧', () => {
  const doc = createDoc()
  const parent = createElement(doc, {
    kind: 'video',
    assetId: 'new-video',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
  })
  const node = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/video',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    params: {
      mode: 'reference',
      continuesFrom: { elementId: parent, assetId: 'old-video', last: true },
    },
  })
  expect(continuationInputs(doc, doc.get(node)!, videoNode, {}).issue?.message).toContain(
    '缺少接续帧',
  )
  setParams(doc, node, {
    mode: 'reference',
    continuesFrom: {
      elementId: parent,
      assetId: 'old-video',
      last: true,
      frameAssetId: 'saved-frame',
    },
  })
  const stale = continuationInputs(doc, doc.get(node)!, videoNode, {})
  expect(stale.issue?.message).toContain('接续帧已旧')
  expect(stale.inputs.images?.[0]).toMatchObject({ assetId: 'saved-frame' })
  doc.destroy()
})

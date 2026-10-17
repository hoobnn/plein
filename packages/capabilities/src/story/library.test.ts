import { connect, createElement, moveElements, reorderInputs } from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import { describe, expect, it } from 'vite-plus/test'
import { cardSnapshot, referenceAssets } from './library'

describe('资产卡快照', () => {
  it('显式调整参考图顺序后，存回资产库使用同一顺序；移动素材不改变主图', () => {
    const doc = openDoc()
    const card = createElement(
      doc,
      node({
        nodeType: 'plein/character',
        name: '林夏',
        ports: {
          inputs: [{ id: 'references', label: '参考', type: 'image', multiple: true }],
          outputs: [],
        },
      }),
    )
    const a = createElement(doc, box({ assetId: 'image-a' }))
    const b = createElement(doc, box({ assetId: 'image-b', y: 200 }))
    const ea = connect(doc, [a, 'image'], [card, 'references'])!
    const eb = connect(doc, [b, 'image'], [card, 'references'])!
    expect(reorderInputs(doc, [card, 'references'], [eb.id, ea.id])).toBe(true)
    moveElements(doc, [a], 0, -1000)
    const el = doc.get(card)!
    expect(referenceAssets(doc, el, 'image')).toEqual(['image-b', 'image-a'])
    expect(cardSnapshot(doc, el, null)!.body.images).toEqual([
      { slot: 'full_body', assetId: 'image-b' },
      { slot: 'extra', assetId: 'image-a' },
    ])
    doc.destroy()
  })
})

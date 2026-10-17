import { createElement } from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { describe, expect, it } from 'vite-plus/test'
import { applyCast } from './cast'
import { referenceAssets } from './library'

describe('抽取角色复用资产库素材', () => {
  it('同图多用途只展开一份画布参考，保留全身图优先和原角色档案', () => {
    const doc = openDoc()
    const source = createElement(doc, node({ nodeType: 'plein/llm' }))
    const profile = { periods: [{ id: 'teen', name: '少年' }], expressions: [] }
    const images = [
      { slot: 'portrait', assetId: 'portrait-image' },
      { slot: 'full_body', assetId: 'full-image' },
      { slot: 'character_3view', assetId: 'full-image' },
      { slot: 'head_3view', assetId: 'portrait-image' },
    ]
    const result = applyCast(
      doc,
      (type) =>
        type === 'plein/character'
          ? node({
              nodeType: type,
              ports: {
                inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
                outputs: [{ id: 'images', label: '参考图', type: 'image' }],
              },
            })
          : undefined,
      source,
      [{ kind: 'character', name: '林夏', description: '短发，白色外套' }],
      {
        library: {
          projectId: null,
          items: [
            {
              id: 'lib_actor',
              kind: 'character',
              name: '林夏',
              description: '',
              voice: null,
              images,
              profile,
              projectId: null,
            },
          ],
        },
      },
    )
    const card = doc.get(result.created[0]!)!
    expect(referenceAssets(doc, card, 'image')).toEqual(['full-image', 'portrait-image'])
    expect(card.params?.profile).toEqual(profile)
    expect(images).toHaveLength(4)
    doc.destroy()
  })
})

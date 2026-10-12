import { characterNode, imageNode, speechNode } from '@plein/nodes'
import { connect, createDoc, createElement } from '@plein/doc'
import type { PortValue } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vitest'
import { applyMentions } from './mentions'

describe('运行前解析 @ 引用', () => {
  const setup = () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const photo = createElement(doc, {
      kind: 'image',
      name: '定妆照',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    const hero = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/character',
      nodeVersion: 1,
      name: '林夏',
      params: { description: '二十岁，短发', voice: 'v_linxia' },
      ports: {
        inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
        outputs: [{ id: 'images', label: '参考图', type: 'image' }],
      },
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    connect(doc, [photo, 'image'], [hero, 'references'])
    return { doc, photo, hero }
  }
  const collect = (doc: ReturnType<typeof setup>['doc']) => async (id: string) => {
    const refs: PortValue[] = []
    for (const e of doc.edges())
      if (e.to[0] === id)
        refs.push({ type: 'image', assetId: doc.get(e.from[0])!.assetId!, kind: 'image' })
    return { references: refs }
  }

  it('图片节点：替换名字、附设定、并入参考图并去重', async () => {
    const { doc, photo } = setup()
    const node = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      params: { prompt: '@林夏站在天台，参考@定妆照' },
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    const r = await applyMentions(doc, doc.get(node)!, imageNode, {}, collect(doc))
    expect(r.params.prompt).toBe('林夏站在天台，参考定妆照\n\n设定：\n林夏：二十岁，短发')
    expect(r.inputs.references).toEqual([
      { type: 'image', assetId: doc.get(photo)!.assetId, kind: 'image' },
    ])
  })

  it('配音节点：不附设定，没选音色时用角色音色', async () => {
    const { doc } = setup()
    const node = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/speech',
      params: { text: '@林夏：你来了', voice: '' },
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    const r = await applyMentions(doc, doc.get(node)!, speechNode, {}, collect(doc))
    expect(r.params).toMatchObject({ text: '林夏：你来了', voice: 'v_linxia' })
  })

  it('没有引用时原样返回', async () => {
    const { doc, hero } = setup()
    const r = await applyMentions(doc, doc.get(hero)!, characterNode, {}, collect(doc))
    expect(r.params).toEqual(doc.get(hero)!.params)
  })
})

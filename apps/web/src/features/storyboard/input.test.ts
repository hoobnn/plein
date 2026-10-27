import type { Engine } from '@plein/canvas-core'
import { connect, createDoc, createElement } from '@plein/doc'
import { storyboardNode, textNode } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { nodeElement, upstreams, validate } from '../../canvas/nodes'

it('分镜补充要求不替代必需剧本，连入实际文本后才可生成', () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  try {
    const boardInfo = { ...describeNode(storyboardNode, 'plein'), executable: true }
    const textInfo = { ...describeNode(textNode, 'plein'), executable: true }
    const engine = { doc } as unknown as Engine
    const catalog = { nodes: [boardInfo, textInfo] } as Catalog
    const board = createElement(doc, {
      ...nodeElement(boardInfo, { prompt: '两个镜头，无对白' }),
      x: 0,
      y: 0,
    })
    expect(validate(boardInfo, doc.get(board)!, upstreams(engine, board, catalog), null)).toBe(
      '需要连入剧本',
    )
    const text = createElement(doc, {
      ...nodeElement(textInfo, { text: '雨后，主角望向桌上的水杯。' }),
      x: -500,
      y: 0,
    })
    connect(doc, [text, 'text'], [board, 'script'])
    expect(validate(boardInfo, doc.get(board)!, upstreams(engine, board, catalog), null)).toBeNull()
  } finally {
    doc.destroy()
    doc.ydoc.destroy()
  }
})

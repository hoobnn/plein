import { addResults, connect, createElement, setText } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import { expect, it } from 'vite-plus/test'
import { mentionEdges } from './mentions'

const edge = (from: string, to: string) => ({ from: [from, '@'], to: [to, '@'] })

it('上游 Markdown 与当前文本结果里的 @ 引用也算消费节点的依赖', () => {
  const doc = openDoc()
  const role = createElement(doc, {
    kind: 'node',
    id: 'role',
    nodeType: 'plein/character',
    name: '林夏',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const markdown = createElement(doc, {
    kind: 'markdown',
    id: 'md',
    x: 0,
    y: 200,
    w: 100,
    h: 100,
  })
  setText(doc, markdown, '镜头参考 @林夏 的造型')
  const image = createElement(doc, {
    kind: 'node',
    id: 'image',
    nodeType: 'plein/image',
    x: 400,
    y: 0,
    w: 100,
    h: 100,
    params: {},
    ports: {
      inputs: [{ id: 'prompt', label: '提示词', type: 'text', multiple: true }],
      outputs: [{ id: 'images', label: '图片', type: 'image' }],
    },
  })
  connect(doc, [markdown, 'text'], [image, 'prompt'])
  expect(mentionEdges(doc)).toEqual([edge(role, image)])

  // 已采用的上游文本结果同样参与解析；历史未采用的候选不算。
  const textNode = createElement(doc, {
    kind: 'node',
    id: 'text-node',
    nodeType: 'plein/llm',
    x: 0,
    y: 400,
    w: 100,
    h: 100,
    params: {},
    ports: {
      inputs: [],
      outputs: [{ id: 'text', label: '输出', type: 'text' }],
    },
  })
  addResults(doc, textNode, [
    {
      id: 'old',
      runId: 'run-old',
      at: 1,
      port: 'text',
      value: { type: 'text', text: '旧稿 @林夏' },
    },
    {
      id: 'current',
      runId: 'run-current',
      at: 2,
      port: 'text',
      value: { type: 'text', text: '现在的稿子' },
    },
  ])
  connect(doc, [textNode, 'text'], [image, 'prompt'])
  expect(mentionEdges(doc)).toEqual([edge(role, image)])

  // 纯文本节点没有采用结果时按它就地计算的正文建立依赖。
  const inline = createElement(doc, {
    kind: 'node',
    id: 'inline',
    nodeType: 'plein/text',
    x: 0,
    y: 600,
    w: 100,
    h: 100,
    params: { text: '继续 @林夏' },
    ports: {
      inputs: [],
      outputs: [{ id: 'text', label: '文本', type: 'text' }],
    },
  })
  connect(doc, [inline, 'text'], [image, 'prompt'])
  // 纯文本节点自己的正文也引用角色，它本身也要排在角色卡片之后。
  expect(mentionEdges(doc)).toEqual([edge(role, image), edge(role, inline)])
  doc.destroy()
})

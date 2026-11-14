import { connect, createElement, setText } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings } from '../testing'

const asset = (c: string) => c.repeat(64)
const SENTINEL = 'plein-external/canvas-a/shared'
const binding = (name: string) => ({
  [`referenceNameBinding:${encodeURIComponent(name)}:${SENTINEL}`]: {
    type: 'image' as const,
    assetId: '',
    source: SENTINEL,
  },
})

/** 目标画布有一个同 id 同名但不同内容的素材；任何模型都不能把它当成外部引用。 */
async function fixture(consumerParams: Record<string, unknown>, upstream = true) {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  createElement(doc, {
    id: 'shared',
    kind: 'image',
    name: '图',
    assetId: asset('c'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const consumer = addNode(doc, 'plein/llm', {
    params: { model: 'plein/mock:agent-vision', prompt: '', ...consumerParams },
    x: 600,
  })
  let markdown: string | undefined
  if (upstream) {
    markdown = createElement(doc, {
      kind: 'markdown',
      id: 'md',
      text: '@图 舞蹈',
      params: binding('图'),
      x: 0,
      y: 300,
      w: 200,
      h: 100,
    })
    connect(doc, [markdown, 'text'], [consumer, 'prompt'])
  }
  return { server, id, doc, consumer, markdown }
}

it('视觉对话消费 Markdown 时，外部失效 @ 不送目标画布同 id 素材且可见', async () => {
  const { server, id, consumer } = await fixture({})
  const input = await server.runs.preview(id, consumer, 'local')
  expect(input.prompt).toContain('@图 舞蹈')
  expect(input.inputs.images ?? []).toEqual([])
  expect(input.refs).toEqual([])
  expect(input.unsent?.some((item) => item.reason === 'stale_binding')).toBe(true)
  expect(input.notices.some((notice) => notice.code === 'stale_binding')).toBe(true)
})

it('视觉对话正文里直接写的外部失效 @ 也不送目标画布同 id 素材', async () => {
  const { server, id, consumer } = await fixture({ prompt: '@图 舞蹈', ...binding('图') }, false)
  const input = await server.runs.preview(id, consumer, 'local')
  expect(input.prompt).toContain('@图 舞蹈')
  expect(input.inputs.images ?? []).toEqual([])
  expect(input.refs).toEqual([])
  expect(input.unsent?.some((item) => item.reason === 'stale_binding')).toBe(true)
  expect(input.notices.some((notice) => notice.code === 'stale_binding')).toBe(true)
})

it('视觉对话里有效的 Markdown @ 仍正常送入图片', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const image = createElement(doc, {
    id: 'extra',
    kind: 'image',
    name: '参考图',
    assetId: asset('d'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const markdown = createElement(doc, { kind: 'markdown', id: 'md', x: 0, y: 300, w: 200, h: 100 })
  setText(doc, markdown, '@参考图 舞蹈')
  const consumer = addNode(doc, 'plein/llm', {
    params: { model: 'plein/mock:agent-vision', prompt: '' },
    x: 600,
  })
  connect(doc, [markdown, 'text'], [consumer, 'prompt'])
  const input = await server.runs.preview(id, consumer, 'local')
  expect(input.status).toBe('ready')
  expect(input.inputs.images).toMatchObject([{ assetId: asset('d'), source: image }])
  expect(input.refs[0]?.sent).toEqual([asset('d')])
  expect(input.unsent ?? []).toEqual([])
})

it('视觉对话的 system 字段也屏蔽外部失效 @，不送同 id 素材', async () => {
  const { server, id, consumer } = await fixture({ system: '讲述 @图', ...binding('图') }, false)
  const input = await server.runs.preview(id, consumer, 'local')
  expect(input.params.system).toBe('讲述 @图')
  expect(input.inputs.images ?? []).toEqual([])
  expect(input.refs).toEqual([])
  expect(input.unsent?.some((item) => item.reason === 'stale_binding')).toBe(true)
  expect(input.notices.some((notice) => notice.code === 'stale_binding')).toBe(true)
})

it('配音节点的 text 正文同样屏蔽外部失效 @', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  createElement(doc, {
    id: 'shared',
    kind: 'image',
    name: '图',
    assetId: asset('c'),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const consumer = addNode(doc, 'plein/speech', {
    params: { text: '朗读 @图', ...binding('图') },
    x: 600,
  })
  const input = await server.runs.preview(id, consumer, 'local')
  expect(input.prompt).toBe('朗读 @图')
  expect(input.unsent?.some((item) => item.reason === 'stale_binding')).toBe(true)
  expect(input.notices.some((notice) => notice.code === 'stale_binding')).toBe(true)
})

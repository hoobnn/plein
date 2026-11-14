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

it('同一失效绑定在 system 与上游 Markdown 同时出现只列一项', async () => {
  const { server, id, consumer } = await fixture({ system: '讲述 @图', ...binding('图') }, true)
  const input = await server.runs.preview(id, consumer, 'local')
  const stale = (input.unsent ?? []).filter((item) => item.reason === 'stale_binding')
  expect(stale).toHaveLength(1)
  expect(stale[0]).toMatchObject({ elementId: SENTINEL, origins: ['binding'] })
  expect(input.notices.filter((notice) => notice.code === 'stale_binding')).toHaveLength(1)
  expect(input.inputs.images ?? []).toEqual([])
})

it('不同输出口的失效绑定仍是独立项，不按显示名合并', async () => {
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
    params: {
      model: 'plein/mock:agent-vision',
      prompt: '',
      system: '先 @图 再 @尾',
      [`referenceNameBinding:${encodeURIComponent('图')}:${SENTINEL}`]: {
        type: 'video',
        assetId: 'v',
        source: SENTINEL,
        sourcePort: 'video',
      },
      [`referenceNameBinding:${encodeURIComponent('尾')}:${SENTINEL}`]: {
        type: 'image',
        assetId: 'f',
        source: SENTINEL,
        sourcePort: 'lastFrame',
      },
    },
    x: 600,
  })
  const input = await server.runs.preview(id, consumer, 'local')
  const stale = (input.unsent ?? []).filter((item) => item.reason === 'stale_binding')
  expect(stale).toHaveLength(2)
  expect(new Set(stale.map((item) => item.name))).toEqual(new Set(['图', '尾']))
  expect(input.params.system).toBe('先 @图 再 @尾')
  expect(input.inputs.images ?? []).toEqual([])
})

it('不同来源的失效绑定各自保留，不按原因合并', async () => {
  const other = 'plein-external/canvas-a/other'
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
    params: {
      model: 'plein/mock:agent-vision',
      prompt: '',
      system: '先 @甲 再 @乙',
      [`referenceNameBinding:${encodeURIComponent('甲')}:${SENTINEL}`]: {
        type: 'image',
        assetId: '',
        source: SENTINEL,
      },
      [`referenceNameBinding:${encodeURIComponent('乙')}:${other}`]: {
        type: 'image',
        assetId: '',
        source: other,
      },
    },
    x: 600,
  })
  const input = await server.runs.preview(id, consumer, 'local')
  const stale = (input.unsent ?? []).filter((item) => item.reason === 'stale_binding')
  expect(stale).toHaveLength(2)
  expect(new Set(stale.map((item) => item.elementId))).toEqual(new Set([SENTINEL, other]))
})

/** 两张 Markdown 各自带一个失效绑定：用第二份的差异检验去重维度。 */
async function twoMarkdown(second: Record<string, unknown>) {
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
  const key = `referenceNameBinding:${encodeURIComponent('图')}`
  const first = createElement(doc, {
    kind: 'markdown',
    id: 'md-1',
    text: '@图 第一段',
    params: {
      [`${key}:${SENTINEL}`]: { type: 'image', assetId: '', source: SENTINEL },
    },
    x: 0,
    y: 200,
    w: 200,
    h: 100,
  })
  const base = { type: 'image', assetId: '', source: SENTINEL }
  const secondSource = SENTINEL
  const other = createElement(doc, {
    kind: 'markdown',
    id: 'md-2',
    text: '@图 第二段',
    params: {
      [`${key}:${String(second.source ?? secondSource)}`]: { ...base, ...second },
    },
    x: 0,
    y: 400,
    w: 200,
    h: 100,
  })
  const consumer = addNode(doc, 'plein/llm', {
    params: { model: 'plein/mock:agent-vision', prompt: '' },
    x: 600,
  })
  connect(doc, [first, 'text'], [consumer, 'prompt'])
  connect(doc, [other, 'text'], [consumer, 'prompt'])
  return { input: await server.runs.preview(id, consumer, 'local') }
}

it.each([
  ['完全相同身份', {}, 1],
  ['不同来源', { source: 'plein-external/canvas-a/other' }, 2],
  ['不同输出口', { sourcePort: 'lastFrame' }, 2],
  ['不同媒体类型', { type: 'video' }, 2],
  ['不同资产', { assetId: 'asset-x' }, 2],
] as const)('两张 Markdown 的失效绑定：%s 时列出 %i 项', async (_label, second, count) => {
  const { input } = await twoMarkdown(second as Record<string, unknown>)
  const stale = (input.unsent ?? []).filter((item) => item.reason === 'stale_binding')
  expect(stale).toHaveLength(count)
  expect(input.prompt).toContain('@图 第一段')
  expect(input.prompt).toContain('@图 第二段')
  expect(input.inputs.images ?? []).toEqual([])
})

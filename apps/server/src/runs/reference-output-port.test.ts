import { addResults, connect, createElement } from '@plein/doc'
import { referenceLabelStyle, referenceMediaLabel } from '@plein/plugin-sdk'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings } from '../testing'

const asset = (c: string) => c.repeat(64)

it('同一视频节点的视频与尾帧各自绑定，实际输入带输出口、提示词按各自编号送入', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const source = addNode(doc, 'plein/video', {
    name: '片段',
    params: { model: 'plein/mock:video', prompt: '空镜', mode: 'text' },
  })
  addResults(doc, source, [
    {
      id: 'r-video',
      runId: 'run-1',
      at: 1,
      port: 'video',
      value: { type: 'video', assetId: asset('v') },
    },
    {
      id: 'r-frame',
      runId: 'run-1',
      at: 2,
      port: 'lastFrame',
      value: { type: 'image', assetId: asset('f') },
    },
  ])
  const target = addNode(doc, 'plein/video', {
    params: {
      model: 'minimax/api:MiniMax-H3',
      mode: 'reference',
      prompt: '@片段 推近，结尾停在 @片段·尾帧',
      [`referenceNameBinding:${encodeURIComponent('片段')}:${source}`]: {
        type: 'video',
        assetId: asset('v'),
        source,
        sourcePort: 'video',
      },
      [`referenceNameBinding:${encodeURIComponent('片段·尾帧')}:${source}`]: {
        type: 'image',
        assetId: asset('f'),
        source,
        sourcePort: 'lastFrame',
      },
    },
    x: 600,
  })
  connect(doc, [source, 'video'], [target, 'videos'])
  connect(doc, [source, 'lastFrame'], [target, 'images'])
  const input = await server.runs.preview(id, target, 'local')
  const style = referenceLabelStyle('video.generate', 'minimax/api')
  expect(input.status).toBe('ready')
  expect(input.prompt).not.toContain('片段')
  expect(input.prompt).toContain(referenceMediaLabel(style, 'video', 1))
  expect(input.prompt).toContain(referenceMediaLabel(style, 'image', 1))
  expect(input.inputs.videos?.[0]).toMatchObject({
    assetId: asset('v'),
    source,
    sourcePort: 'video',
  })
  expect(input.inputs.images?.[0]).toMatchObject({
    assetId: asset('f'),
    source,
    sourcePort: 'lastFrame',
  })
})

it('替换成还没生成的新来源先阻断，生成后只用新来源', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const old = addNode(doc, 'plein/image', {
    name: '旧图',
    params: { model: 'plein/mock:image', prompt: '旧' },
  })
  addResults(doc, old, [
    {
      id: 'old-result',
      runId: 'run-old',
      at: 1,
      port: 'images',
      value: { type: 'image', assetId: asset('a') },
    },
  ])
  const next = addNode(doc, 'plein/image', {
    name: '新图',
    params: { model: 'plein/mock:image', prompt: '新' },
  })
  const target = addNode(doc, 'plein/video', {
    params: {
      model: 'minimax/api:MiniMax-H3',
      mode: 'reference',
      prompt: '@新图 保持构图',
      [`referenceNameBinding:${encodeURIComponent('新图')}:${next}`]: {
        type: 'image',
        assetId: '',
        source: next,
      },
    },
    x: 600,
  })
  connect(doc, [next, 'images'], [target, 'images'])
  const blocked = await server.runs.preview(id, target, 'local')
  // 上游还没结果时整步阻断（unprepared），有结果后才允许提交。
  expect(['blocked', 'unprepared']).toContain(blocked.status)
  expect(blocked.blocked.map((issue) => issue.message).join(' ')).toMatch(/还没有结果|还没生成/)
  addResults(doc, next, [
    {
      id: 'next-result',
      runId: 'run-next',
      at: 1,
      port: 'images',
      value: { type: 'image', assetId: asset('b') },
    },
  ])
  const ready = await server.runs.preview(id, target, 'local')
  const style = referenceLabelStyle('video.generate', 'minimax/api')
  expect(ready.status).toBe('ready')
  expect(ready.prompt).toContain(referenceMediaLabel(style, 'image', 1))
  expect(ready.prompt).not.toContain('新图')
  expect(ready.inputs.images).toMatchObject([
    { assetId: asset('b'), source: next, sourcePort: 'images' },
  ])
})

it('跨画布外部 Markdown 引用在消费时保持可读且失效，不接管目标同 id 素材', async () => {
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
  const sentinel = 'plein/external:canvas-a:shared'
  const markdown = createElement(doc, {
    kind: 'markdown',
    id: 'md',
    text: '@图 舞蹈',
    x: 0,
    y: 200,
    w: 200,
    h: 100,
    params: {
      [`referenceNameBinding:${encodeURIComponent('图')}:${sentinel}`]: {
        type: 'image',
        assetId: '',
        source: sentinel,
      },
    },
  })
  const target = addNode(doc, 'plein/video', {
    params: { model: 'minimax/api:MiniMax-H3', mode: 'reference', prompt: '' },
    x: 600,
  })
  connect(doc, [markdown, 'text'], [target, 'prompt'])
  const input = await server.runs.preview(id, target, 'local')
  expect(input.prompt).toContain('@图 舞蹈')
  expect(input.inputs.images ?? []).toEqual([])
  expect(input.notices.some((notice) => notice.code === 'stale_binding')).toBe(true)
})

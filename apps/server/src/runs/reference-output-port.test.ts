import { addResults, connect } from '@plein/doc'
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

import { expect, it, vi } from 'vite-plus/test'
import { Readable } from 'node:stream'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import { connect, createElement, removeEdges, setParam } from '@plein/doc'
import { addNode, bootServer, createCanvas } from '../testing'

it('动画字幕序列缓存包含渲染器身份；普通字幕不依赖 HyperFrames', async () => {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const nodeId = addNode(doc, 'plein/sequence', { params: { subtitleRender: 'animated' } })
  const identity = vi
    .spyOn(server.plugins, 'compositionRendererIdentity')
    .mockReturnValue('build-a')
  const first = await server.runs.preview(canvasId, nodeId, 'local')
  identity.mockReturnValue('build-b')
  const changed = await server.runs.preview(canvasId, nodeId, 'local')
  expect(changed.inputHash).not.toBe(first.inputHash)
  setParam(doc, nodeId, 'subtitleRender', 'static')
  const ordinary = await server.runs.preview(canvasId, nodeId, 'local')
  identity.mockReturnValue('build-c')
  expect((await server.runs.preview(canvasId, nodeId, 'local')).inputHash).toBe(ordinary.inputHash)
})

it('同素材换上游元素不能绕过序列来源绑定校验命中旧缓存', async () => {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const asset = await server.assets.ingest(
    'local',
    Readable.from(Buffer.from(MOCK_WEBM_BASE64, 'base64')),
    { mime: 'video/webm', name: 'clip.webm' },
  )
  const video = () =>
    createElement(doc, {
      kind: 'video',
      assetId: asset.id,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
    })
  const first = video(),
    replacement = video(),
    background = video()
  const sequence = addNode(doc, 'plein/sequence', {
    params: { overlays: [{ id: 'one', source: first, duration: 1 }] },
  })
  connect(doc, [background, 'video'], [sequence, 'clips'])
  const edge = connect(doc, [first, 'video'], [sequence, 'overlays'])!
  const before = await server.runs.preview(canvasId, sequence, 'local')
  removeEdges(doc, [edge.id])
  connect(doc, [replacement, 'video'], [sequence, 'overlays'])
  const after = await server.runs.preview(canvasId, sequence, 'local')
  expect(after.inputHash).not.toBe(before.inputHash)
})

it('素材上的动态合成来源不合法时直接拒绝，不猜来源', async () => {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const asset = await server.assets.ingest(
    'local',
    Readable.from(Buffer.from(MOCK_WEBM_BASE64, 'base64')),
    { mime: 'video/webm', name: 'clip.webm' },
  )
  // 来源缺字段，不能当成「没有来源」放行
  const broken = createElement(doc, {
    kind: 'video',
    assetId: asset.id,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    params: { compositionSource: { version: 1 } },
    ports: { inputs: [], outputs: [{ id: 'video', label: '视频', type: 'video' }] },
  })
  const sequence = addNode(doc, 'plein/sequence', { params: { subtitles: false } })
  connect(doc, [broken, 'video'], [sequence, 'clips'])
  const job = server.runs.start(canvasId, sequence, 'local')
  expect(await server.runs.wait(job)).toBe('failed')
  expect(server.runs.store.get(job)?.error).toContain('素材的动态合成来源不合法')
})

it('影响范围里没有可运行的节点时直接拒绝，不建批次', async () => {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const node = addNode(doc, 'plein/image', { params: { prompt: 'x' } })
  expect(server.runs.runImpact(canvasId, 'local', { nodes: [node], force: false }).total).toBe(1)
  // 目标不是可运行的节点时整组不成立
  expect(() =>
    server.runs.runImpact(canvasId, 'local', { nodes: ['not-a-node'], force: false }),
  ).toThrow('没有需要运行的节点')
})

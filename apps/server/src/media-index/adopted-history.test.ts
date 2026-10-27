import { Readable } from 'node:stream'
import { addResults, adoptResult } from '@plein/doc'
import type { Canvas, MediaSourcesPage } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request, until } from '../testing'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'

it('历史采用旧尾帧后 HTTP 封面与素材来源都认同配对主视频，撤销恢复新结果', async () => {
  const { server } = await bootServer()
  await until(() => server.mediaIndex.ready)
  const { id: canvasId, doc } = await createCanvas(server)
  const nodeId = addNode(doc, 'plein/video', { params: {} })
  const video = await server.assets.ingest(
    'local',
    Readable.from([Buffer.from(MOCK_WEBM_BASE64, 'base64')]),
    { mime: 'video/webm', name: 'video.webm' },
  )
  const tail = await server.assets.ingest(
    'local',
    Readable.from([solidPng(32, 32, [20, 80, 150])]),
    { mime: 'image/png', name: 'tail.png' },
  )
  // 两个候选可复用相同文件，采用标记仍必须绑定具体结果。
  const assets = [video, video, tail]
  addResults(doc, nodeId, [
    {
      id: 'video-old',
      runId: 'old',
      outputGroup: 'old',
      port: 'video',
      at: 1,
      value: { type: 'video', assetId: assets[0]!.id },
    },
    {
      id: 'tail-old',
      runId: 'old',
      outputGroup: 'old',
      port: 'lastFrame',
      at: 1,
      value: { type: 'image', assetId: assets[2]!.id },
    },
  ])
  addResults(doc, nodeId, [
    {
      id: 'video-new',
      runId: 'new',
      port: 'video',
      at: 2,
      value: { type: 'video', assetId: assets[1]!.id },
    },
  ])
  doc.undo.stopCapturing()
  adoptResult(doc, nodeId, 'tail-old')
  const verify = async (old: boolean) => {
    doc.flush()
    server.rooms.get(canvasId).flush()
    const list = await request(server, '/api/canvases')
    expect(list.status).toBe(200)
    const canvases = (await list.json()) as Canvas[]
    expect(canvases.find((canvas) => canvas.id === canvasId)?.covers?.join(' ')).toContain(
      assets[old ? 0 : 1]!.id,
    )
    for (const index of [0, 2]) {
      const response = await request(server, `/api/assets/${assets[index]!.id}/sources`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as MediaSourcesPage
      expect(
        body.items
          .filter((item) => item.type === 'canvas' && item.nodeId === nodeId && item.adopted)
          .map((item) => item.resultId),
      ).toEqual(index === 0 ? [old ? 'video-old' : 'video-new'] : old ? ['tail-old'] : [])
    }
  }
  await verify(true)
  doc.undo.undo()
  await verify(false)
  doc.undo.redo()
  await verify(true)
})

import { Readable } from 'node:stream'
import { addResults, removeResults } from '@plein/doc'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, until } from '../testing'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'

/**
 * 结果数组是元素映射里的子类型：逐条插删只改子数组，元素自身的键没动。
 * 素材索引要认得这种变化，否则刚加进来的候选不会被登记，
 * 删掉的候选也还留在索引里。
 */
it('候选逐条增删都会更新素材索引', async () => {
  const { server } = await bootServer()
  await until(() => server.mediaIndex.ready)
  const { id: canvasId, doc } = await createCanvas(server)
  const nodeId = addNode(doc, 'plein/video', { params: {} })
  const video = await server.assets.ingest(
    'local',
    Readable.from([Buffer.from(MOCK_WEBM_BASE64, 'base64')]),
    { mime: 'video/webm', name: 'video.webm' },
  )
  const still = await server.assets.ingest(
    'local',
    Readable.from([solidPng(32, 32, [20, 80, 150])]),
    { mime: 'image/png', name: 'still.png' },
  )

  // 只入候选、不采用：索引里也要能查到这份文件
  addResults(
    doc,
    nodeId,
    [
      {
        id: 'candidate-a',
        runId: 'run-a',
        port: 'video',
        at: 1,
        value: { type: 'video', assetId: video.id },
      },
      {
        id: 'candidate-b',
        runId: 'run-b',
        port: 'lastFrame',
        at: 2,
        value: { type: 'image', assetId: still.id },
      },
    ],
    { adopt: false },
  )
  server.rooms.get(canvasId).flush()
  await until(() => server.mediaIndex.sources('local', video.id, { limit: 50 }).items.length > 0)
  expect(server.mediaIndex.sources('local', video.id, { limit: 50 }).items.length).toBeGreaterThan(
    0,
  )
  expect(server.mediaIndex.sources('local', still.id, { limit: 50 }).items.length).toBeGreaterThan(
    0,
  )

  // 删掉一条候选：索引里这份文件不再作为该节点的来源
  removeResults(doc, [{ elementId: nodeId, resultId: 'candidate-b' }])
  server.rooms.get(canvasId).flush()
  await until(() => server.mediaIndex.sources('local', still.id, { limit: 50 }).items.length === 0)
  expect(server.mediaIndex.sources('local', still.id, { limit: 50 }).items).toEqual([])
  // 另一条还在
  expect(server.mediaIndex.sources('local', video.id, { limit: 50 }).items.length).toBeGreaterThan(
    0,
  )
})

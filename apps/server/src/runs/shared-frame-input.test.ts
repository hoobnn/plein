import { connect, createElement } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

it('相同资产的两个首尾帧来源在预览和执行快照中保持顺序与两个槽位', async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const assetId = 'a'.repeat(64)
  const sources = ['循环开场', '循环结束'].map((name, i) =>
    createElement(doc, {
      kind: 'image',
      assetId,
      name,
      x: i * 200,
      y: 0,
      w: 100,
      h: 80,
    }),
  )
  const video = addNode(doc, 'plein/video', {
    params: { model: 'plein/mock:video', mode: 'frames', prompt: '绕水杯一周回到原处' },
  })
  sources.forEach((source) => connect(doc, [source, 'image'], [video, 'images']))
  const response = await request(server, `/api/canvases/${id}/nodes/${video}/input`)
  expect(response.status).toBe(200)
  const input = (await response.json()) as PreparedInput
  expect(input.inputs.images?.map((value) => [value.source, value.assetId])).toEqual(
    sources.map((source) => [source, assetId]),
  )
  const run = await request(server, `/api/canvases/${id}/nodes/${video}/run`, {
    method: 'POST',
    body: JSON.stringify({ expect: input.inputHash }),
  })
  expect(run.status).toBe(202)
  const { runId } = (await run.json()) as { runId: string }
  expect(await server.runs.wait(runId)).toBe('succeeded')
  const jobs = await request(server, `/api/canvases/${id}/jobs`)
  const result = (await jobs.json()) as { jobs: Array<{ input: PreparedInput }> }
  expect(
    result.jobs[0]!.input.inputs.images?.map((value) => [value.source, value.assetId]),
  ).toEqual(sources.map((source) => [source, assetId]))
})

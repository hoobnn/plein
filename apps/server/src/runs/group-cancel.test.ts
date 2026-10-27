import { createElement } from '@plein/doc'
import type { GroupRunStarted, JobList } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request, until } from '../testing'

it('停止整组同时取消运行与排队节点，HTTP 记录与文档保持一致', async () => {
  const { server } = await bootServer({ env: { PLEIN_MAX_JOBS: '1' } })
  mockSettings(server, { latencyMs: 60_000 })
  const { id, doc } = await createCanvas(server)
  const frame = createElement(doc, { kind: 'frame', x: 0, y: 0, w: 1000, h: 600 })
  const nodes = Array.from({ length: 5 }, (_, i) =>
    addNode(doc, 'plein/image', {
      parentId: frame,
      x: i * 200,
      params: { prompt: `透明水杯 ${i}` },
    }),
  )
  const started = await request(server, `/api/canvases/${id}/frames/${frame}/run`, {
    method: 'POST',
    body: '{}',
  })
  expect(started.status).toBe(202)
  const { groupId } = (await started.json()) as GroupRunStarted
  try {
    await until(
      () =>
        nodes.some((node) => doc.get(node)?.run?.status === 'running') &&
        nodes.some((node) => doc.get(node)?.run?.status === 'queued'),
    )
    const canceled = await request(server, `/api/runs/groups/${groupId}/cancel`, { method: 'POST' })
    expect(canceled.status).toBe(204)
    await until(() => nodes.every((node) => doc.get(node)?.run?.status === 'canceled'))
    const response = await request(server, `/api/canvases/${id}/jobs`)
    expect(response.status).toBe(200)
    const list = (await response.json()) as JobList
    expect(list.groups.find((group) => group.id === groupId)?.status).toBe('canceled')
    expect(list.jobs.filter((job) => job.groupId === groupId).map((job) => job.status)).toEqual(
      Array(5).fill('canceled'),
    )
  } finally {
    await request(server, `/api/runs/groups/${groupId}/cancel`, { method: 'POST' })
  }
})

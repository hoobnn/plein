import type { Canvas, LibraryItem } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'

it('按画布项目新建角色后，项目归属写入数据库并在重启后保留', async () => {
  const first = await bootServer({ mock: false })
  const canvasResponse = await request(first.server, '/api/canvases', {
    method: 'POST',
    body: JSON.stringify({ title: '角色所属画布' }),
  })
  expect(canvasResponse.status).toBe(201)
  const canvas = (await canvasResponse.json()) as Canvas
  const response = await request(first.server, '/api/library', {
    method: 'POST',
    body: JSON.stringify({ kind: 'character', name: '雨后角色', projectId: canvas.projectId }),
  })
  expect(response.status).toBe(201)
  const item = (await response.json()) as LibraryItem
  expect(item).toMatchObject({ kind: 'character', name: '雨后角色', projectId: canvas.projectId })
  expect(
    first.server.db.$client.prepare('SELECT project_id FROM library_items WHERE id=?').get(item.id),
  ).toEqual({ project_id: canvas.projectId })
  await first.close()
  const restarted = await bootServer({ dataDir: first.dataDir, mock: false })
  const read = await request(restarted.server, `/api/library/${item.id}`)
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({ id: item.id, projectId: canvas.projectId })
  const list = await request(restarted.server, '/api/library?kind=character')
  expect(list.status).toBe(200)
  expect(await list.json()).toEqual([item])
})

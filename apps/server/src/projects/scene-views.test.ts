import { Readable } from 'node:stream'
import type { Canvas, LibraryItem, ProjectPackageManifest } from '@plein/protocol'
import { strFromU8, unzipSync } from 'fflate'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request } from '../testing'

it('项目包保留库视角并带入视角图片，画布缺失视角图按强引用报告', async () => {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const canvas = (await (await request(server, `/api/canvases/${id}`)).json()) as Canvas
  const image = await server.assets.ingest(
    'local',
    Readable.from([solidPng(32, 24, [20, 70, 90])]),
    {
      mime: 'image/png',
      name: 'door.png',
    },
  )
  const created = await request(server, '/api/library', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'scene',
      name: '教室',
      projectId: canvas.projectId,
      sceneViews: [
        { id: 'door', name: '门口', aliases: [], description: '看向黑板', images: [image.id] },
      ],
    }),
  })
  expect(created.status).toBe(201)
  const item = (await created.json()) as LibraryItem
  const missing = 'f'.repeat(64)
  addNode(doc, 'plein/scene', {
    name: '教室',
    params: {
      libraryId: item.id,
      sceneViews: [{ id: 'gone', name: '已丢失', aliases: [], description: '', images: [missing] }],
    },
  })

  const res = await request(server, `/api/projects/${canvas.projectId}/package`)
  expect(res.status).toBe(200)
  const archive = unzipSync(new Uint8Array(await res.arrayBuffer()))
  const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as ProjectPackageManifest
  expect(manifest.library.find((entry) => entry.id === item.id)?.sceneViews?.[0]?.images).toEqual([
    image.id,
  ])
  expect(manifest.assets.map((asset) => asset.id)).toContain(image.id)
  expect(manifest.missing).toContainEqual({
    kind: 'asset',
    id: missing,
    where: expect.stringContaining('教室'),
  })
})

import { setParam } from '@plein/doc'
import { CreateLibraryItem, type SaveLibraryCardResult } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request } from '../testing'

it('旧 save-card 快照保留已有场景视角，显式空数组才清空', async () => {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const scene = addNode(doc, 'plein/scene', { name: '教室' })
  const item = server.library.create(
    'local',
    CreateLibraryItem.parse({
      kind: 'scene',
      name: '教室',
      sceneViews: [
        {
          id: 'door',
          name: '门口',
          aliases: ['旧门口'],
          description: '保留我',
          images: ['a'.repeat(64)],
        },
      ],
    }),
  )
  setParam(doc, scene, 'libraryId', item.id)
  const save = (snapshot: Record<string, unknown>) =>
    request(server, '/api/library/save-card', {
      method: 'POST',
      body: JSON.stringify({
        canvasId: id,
        nodeId: scene,
        expectedLibraryId: item.id,
        snapshot,
      }),
    })

  const legacy = await save({ kind: 'scene', name: '旧客户端新名称' })
  expect(legacy.status).toBe(200)
  expect(((await legacy.json()) as SaveLibraryCardResult).item.sceneViews).toEqual(item.sceneViews)
  expect(server.library.get('local', item.id)?.sceneViews).toEqual(item.sceneViews)

  const cleared = await save({ kind: 'scene', name: '新客户端', sceneViews: [] })
  expect(cleared.status).toBe(200)
  expect(server.library.get('local', item.id)?.sceneViews).toEqual([])
})

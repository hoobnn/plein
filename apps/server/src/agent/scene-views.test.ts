import { CreateLibraryItem } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { bootServer, createCanvas } from '../testing'
import { serverCapabilities, serverContext, type ToolEnv } from './tools'

it('智能体放置场景时报告视角截图及全景来源缺失，不添加基础参考连线', async () => {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const env: ToolEnv = {
    canvasId: id,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    library: server.library,
    mediaIndex: server.mediaIndex,
    checkpoints: server.checkpoints,
    canvasApi: server.canvasApi,
  }
  const missing = 'f'.repeat(64)
  const missingPanorama = 'e'.repeat(64)
  const item = server.library.create(
    'local',
    CreateLibraryItem.parse({
      kind: 'scene',
      name: '教室',
      sceneViews: [
        {
          id: 'door',
          name: '门口',
          aliases: [],
          description: '',
          images: [missing],
          panorama: { assetId: missingPanorama, yaw: 0, pitch: 0, fov: 55, format: 'landscape' },
        },
      ],
    }),
  )
  const placed = (await serverCapabilities.invoke('place_library_item', serverContext(env), {
    item_id: item.id,
  })) as { id: string; skipped_assets?: number }
  expect(placed.skipped_assets).toBe(2)
  expect(doc.get(placed.id)?.params?.sceneViews).toEqual(item.sceneViews)
  expect([...doc.edges()].filter((edge) => edge.to[0] === placed.id)).toEqual([])
})

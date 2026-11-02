import { Readable } from 'node:stream'
import { createElement } from '@plein/doc'
import type { MediaSourcesPage } from '@plein/protocol'
import { expect, it } from 'vite-plus/test'
import { bootServer, createCanvas, request, until } from '../testing'
import { solidPng } from '../../../../packages/providers/src/mock/media'

/**
 * 挂载顺序守护：素材来源路由 /api/assets/:id/sources 必须排在资产文件路由
 * /api/assets/:id/:variant? 之前。顺序颠倒时资产路由会把 "sources" 当成变体名抢先匹配，
 * 来源分页就变成 404 或返回资产文件。详见 apps/server/src/app.ts 的注释。
 */
it('来源路由不被资产变体路由抢先匹配', async () => {
  const { server } = await bootServer()
  await until(() => server.mediaIndex.ready)
  const { id: canvasId, doc } = await createCanvas(server)
  const asset = await server.assets.ingest(
    'local',
    Readable.from([solidPng(32, 32, [20, 80, 150])]),
    { mime: 'image/png', name: 'route-order.png' },
  )
  const nodeId = createElement(doc, {
    kind: 'image',
    assetId: asset.id,
    x: 0,
    y: 0,
    w: 10,
    h: 10,
  })
  doc.flush()
  server.rooms.get(canvasId).flush()

  const response = await request(server, `/api/assets/${asset.id}/sources`)
  expect(
    response.status,
    '来源路由没有拿到请求：挂载顺序被调换了，资产变体路由 /api/assets/:id/:variant? 抢先匹配了 /api/assets/:id/sources，见 apps/server/src/app.ts 的注释',
  ).toBe(200)
  expect(
    response.headers.get('content-type'),
    '来源路由返回的不是 JSON：挂载顺序被调换了，资产文件路由抢先匹配了 /api/assets/:id/sources，见 apps/server/src/app.ts 的注释',
  ).toContain('application/json')
  const body = (await response.json()) as MediaSourcesPage
  expect(Array.isArray(body.items)).toBe(true)
  expect(body.items).toEqual([
    expect.objectContaining({ type: 'canvas', canvasId, nodeId, locatable: true }),
  ])
})

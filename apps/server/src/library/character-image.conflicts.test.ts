import { Readable } from 'node:stream'
import { addResults, adoptResult, setParams, updateElement } from '@plein/doc'
import {
  characterImageRevision,
  CreateLibraryItem,
  type ArchiveCharacterImage,
} from '@plein/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vite-plus/test'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import type { AuthEnv } from '../auth'
import { addNode, bootServer, createCanvas } from '../testing'
import { librarySyncRoutes } from './sync'

/** 一个绑定了角色目标的图片节点，用来逐条触发归档冲突。 */
async function fixture() {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const images = await Promise.all(
    [20, 120].map((color) =>
      server.assets.ingest('local', Readable.from([solidPng(32, 24, [color, 90, 100])]), {
        mime: 'image/png',
        name: 'portrait.png',
      }),
    ),
  )
  const item = server.library.create(
    'local',
    CreateLibraryItem.parse({
      kind: 'character',
      name: '原角色',
      images: [{ slot: 'portrait', assetId: images[0]!.id }],
    }),
  )
  const nodeId = addNode(doc, 'plein/image', {
    params: {
      prompt: '角色肖像',
      characterAssetTarget: { libraryId: item.id, slot: 'portrait' },
    },
  })
  addResults(doc, nodeId, [
    {
      id: 'chosen',
      runId: 'fixture-only',
      at: 1,
      port: 'images',
      value: { type: 'image', assetId: images[1]!.id, mime: 'image/png' },
    },
  ])
  adoptResult(doc, nodeId, 'chosen')
  const body: ArchiveCharacterImage = {
    canvasId,
    nodeId,
    resultId: 'chosen',
    assetId: images[1]!.id,
    sourceSlot: 'portrait',
    slot: 'portrait',
    expected: characterImageRevision(item),
    cover: true,
  }
  const app = new Hono<AuthEnv>()
    .use('*', (c, next) => {
      c.set('principal', { id: 'local', role: 'owner' })
      return next()
    })
    .route(
      '/',
      librarySyncRoutes({
        db: server.db,
        rooms: server.rooms,
        assets: server.assets,
        library: server.library,
      }),
    )
  const archive = async (patch: Partial<ArchiveCharacterImage> = {}) => {
    const response = await app.request(`/api/library/${item.id}/character-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...patch }),
    })
    return { status: response.status, body: (await response.json()) as { message: string } }
  }
  return { server, doc, nodeId, images, item, body, archive }
}

describe('归档冲突原因分类', () => {
  it('节点锁定时说清要先解锁', async () => {
    const f = await fixture()
    updateElement(f.doc, f.nodeId, { locked: true })
    const result = await f.archive()
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('已锁定')
    expect(result.body.message).toContain('解锁')
  })

  it('角色关联变了时说清已不再关联这个角色', async () => {
    const f = await fixture()
    setParams(f.doc, f.nodeId, {
      characterAssetTarget: { libraryId: 'different-role', slot: 'portrait' },
    })
    const result = await f.archive()
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('不再关联这个角色')
  })

  it('槽位变了时说清是槽位变化', async () => {
    const f = await fixture()
    setParams(f.doc, f.nodeId, {
      characterAssetTarget: { libraryId: f.item.id, slot: 'face_grid' },
    })
    const result = await f.archive()
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('角色槽位已变化')
  })

  it('采用项换了时说清要重新选候选', async () => {
    const f = await fixture()
    addResults(f.doc, f.nodeId, [
      {
        id: 'next',
        runId: 'next-fixture',
        at: 2,
        port: 'images',
        value: { type: 'image', assetId: f.images[0]!.id },
      },
    ])
    adoptResult(f.doc, f.nodeId, 'next')
    const result = await f.archive()
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('来源候选已更新')
  })

  it('候选内容变了时说清已经换成别的图片', async () => {
    const f = await fixture()
    const result = await f.archive({ assetId: f.images[0]!.id })
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('已经换成别的图片')
  })

  it('角色本身变了时说清要重新读取角色', async () => {
    const f = await fixture()
    f.server.library.update('local', f.item.id, { name: '改过名的角色' })
    const result = await f.archive()
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('角色或图片已变化')
  })

  it('素材缺失时说清要先恢复素材', async () => {
    const f = await fixture()
    // 候选指向一张已经不在资产库里的图：素材没了，不是候选换了
    const gone = 'e'.repeat(64)
    addResults(f.doc, f.nodeId, [
      {
        id: 'gone',
        runId: 'gone-fixture',
        at: 2,
        port: 'images',
        value: { type: 'image', assetId: gone, mime: 'image/png' },
      },
    ])
    adoptResult(f.doc, f.nodeId, 'gone')
    const result = await f.archive({ resultId: 'gone', assetId: gone })
    expect(result.status).toBe(409)
    expect(result.body.message).toContain('候选图片缺失')
  })

  it('冲突后原档案的图片保持不变', async () => {
    const f = await fixture()
    updateElement(f.doc, f.nodeId, { locked: true })
    await f.archive()
    expect(f.server.library.get('local', f.item.id)?.images).toEqual(f.item.images)
  })
})

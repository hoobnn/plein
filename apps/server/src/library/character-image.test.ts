import { Readable } from 'node:stream'
import { addResults, adoptResult, setParams, updateElement } from '@plein/doc'
import {
  characterImageRevision,
  CreateLibraryItem,
  type ArchiveCharacterImage,
  type LibraryItem,
  type Canvas,
  type ProjectImportPreview,
  type ProjectImportResult,
  type ProjectPackageManifest,
} from '@plein/protocol'
import { Hono } from 'hono'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vite-plus/test'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import type { AuthEnv } from '../auth'
import { insertProject } from '../storage/canvases'
import { addNode, bootServer, createCanvas, request } from '../testing'
import { librarySyncRoutes } from './sync'

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
  const projectId = insertProject(server.db, 'local', '原角色项目')
  const item = server.library.create(
    'local',
    CreateLibraryItem.parse({
      kind: 'character',
      name: '原角色',
      projectId,
      description: '保留的设定',
      tags: { era: '现代' },
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
    slot: 'portrait',
    expected: characterImageRevision(item),
    cover: true,
  }
  const app = (owner = 'local', role: 'owner' | 'viewer' = 'owner') =>
    new Hono<AuthEnv>()
      .use('*', (c, next) => {
        c.set('principal', { id: owner, role })
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
  const archive = (patch: Partial<ArchiveCharacterImage> = {}, actor = app()) =>
    actor.request(`/api/library/${item.id}/character-image`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...patch }),
    })
  return { server, doc, canvasId, nodeId, images, item, body, app, archive }
}

describe('角色候选精确归档', () => {
  it('只归档明确候选到原角色，旧图保留，独立封面不改变图片类别或项目', async () => {
    const f = await fixture()
    const response = await f.archive()
    expect(response.status).toBe(200)
    const saved = (await response.json()) as LibraryItem
    expect(saved).toMatchObject({
      id: f.item.id,
      projectId: f.item.projectId,
      description: '保留的设定',
      tags: { era: '现代' },
      coverAssetId: f.images[1]!.id,
    })
    expect(saved.images).toEqual([
      { slot: 'extra', assetId: f.images[0]!.id },
      { slot: 'portrait', assetId: f.images[1]!.id },
    ])
    expect(saved.images.some((image) => image.slot === 'full_body')).toBe(false)
    expect(f.server.db.$client.prepare('SELECT count(*) AS n FROM jobs').get()).toMatchObject({
      n: 0,
    })
    expect((await f.archive()).status).toBe(409)
    expect(f.server.library.get('local', f.item.id)?.images).toEqual(saved.images)
  })

  it('拒绝同毫秒改图的旧确认；刷新后移动已有图片不重复占容量', async () => {
    const f = await fixture()
    f.server.library.update('local', f.item.id, {
      images: [...f.item.images, { slot: 'extra', assetId: f.images[1]!.id }],
    })
    f.server.db.$client
      .prepare('UPDATE library_items SET updated_at=? WHERE id=?')
      .run(f.item.updatedAt, f.item.id)
    expect((await f.archive()).status).toBe(409)
    const item = f.server.library.get('local', f.item.id)!
    const response = await f.archive({
      expected: characterImageRevision(item),
      slot: 'face_grid',
      cover: false,
    })
    expect(response.status).toBe(200)
    expect(((await response.json()) as LibraryItem).images).toEqual([
      ...f.item.images,
      { slot: 'face_grid', assetId: f.images[1]!.id },
    ])
  })

  it('采用项、角色目标、图片或锁定变化均拒绝；viewer 与其他所有者不能写', async () => {
    const f = await fixture()
    expect((await f.archive({}, f.app('local', 'viewer'))).status).toBe(403)
    expect((await f.archive({}, f.app('another'))).status).toBe(404)
    expect((await f.archive({ assetId: f.images[0]!.id })).status).toBe(409)
    updateElement(f.doc, f.nodeId, { locked: true })
    expect((await f.archive()).status).toBe(409)
    updateElement(f.doc, f.nodeId, { locked: false })
    setParams(f.doc, f.nodeId, {
      characterAssetTarget: { libraryId: 'different-role', slot: 'portrait' },
    })
    expect((await f.archive()).status).toBe(409)
    setParams(f.doc, f.nodeId, { characterAssetTarget: { libraryId: f.item.id, slot: 'portrait' } })
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
    expect((await f.archive()).status).toBe(409)
    expect(f.server.library.get('local', f.item.id)?.images).toEqual(f.item.images)
  })

  it('已满24图时不丢原槽位，不写入新封面', async () => {
    const f = await fixture()
    const images = [
      ...f.item.images,
      ...Array.from({ length: 23 }, (_, i) => ({
        slot: 'extra',
        assetId: (i + 1).toString(16).padStart(64, '0'),
      })),
    ]
    const full = f.server.library.update('local', f.item.id, { images })!
    expect((await f.archive({ expected: characterImageRevision(full) })).status).toBe(409)
    expect(f.server.library.get('local', f.item.id)?.images).toEqual(images)
    expect(f.server.library.get('local', f.item.id)?.coverAssetId).toBeNull()
  })

  it('仅制作草稿也打包原角色及独立封面，导入副本映射目标ID', async () => {
    const f = await fixture()
    expect((await f.archive()).status).toBe(200)
    const canvas = (await (await request(f.server, `/api/canvases/${f.canvasId}`)).json()) as Canvas
    const response = await request(f.server, `/api/projects/${canvas.projectId}/package`)
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const zip = unzipSync(bytes)
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as ProjectPackageManifest
    expect(manifest.library).toContainEqual(
      expect.objectContaining({ id: f.item.id, coverAssetId: f.images[1]!.id }),
    )
    const inspect = await request(f.server, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(inspect.status).toBe(201)
    const preview = (await inspect.json()) as ProjectImportPreview
    const committed = await request(f.server, `/api/project-imports/${preview.token}`, {
      method: 'POST',
      body: '{}',
    })
    expect(committed.status).toBe(201)
    const imported = (await committed.json()) as ProjectImportResult
    if (!imported.canvasId) throw new Error('项目包未恢复画布')
    const restored = f.server.rooms.withDoc(imported.canvasId, (doc) => doc.get(f.nodeId))!
    const target = restored.params?.characterAssetTarget as { libraryId: string }
    expect(f.server.library.get('local', target.libraryId)?.coverAssetId).toBe(f.images[1]!.id)
    expect(target.libraryId).toBe(f.item.id) // Shared original-project library entries are deliberately reused.
  })
})

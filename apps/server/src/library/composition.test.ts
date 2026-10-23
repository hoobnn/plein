import { renameSync } from 'node:fs'
import { Readable } from 'node:stream'
import { cardSnapshot, referenceMedia } from '@plein/capabilities'
import { addResults, connect, createDoc, deleteElements, inputEdges } from '@plein/doc'
import { MOTION_TEMPLATE_VERSION, MotionParams } from '@plein/nodes'
import type { CompositionSourceRef } from '@plein/plugin-sdk'
import {
  CreateLibraryItem,
  type LibraryItem,
  type LibraryUpdates,
  type ProjectImportPreview,
  type ProjectPackageManifest,
  type SaveLibraryCardResult,
} from '@plein/protocol'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import * as Y from 'yjs'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import { MOCK_WEBM_BASE64 } from '../../../../packages/providers/src/mock/video-fixture'
import type { Server } from '../app'
import { placeLibraryItem } from '../agent/library'
import { serverContext } from '../agent/tools'
import { compositionReferences } from '../media-index/references'
import { HYPERFRAMES_VERSION } from '../motion/runtime'
import { insertCanvas, insertProject } from '../storage/canvases'
import { addNode, bootServer, request, until } from '../testing'

async function fixture() {
  const { server } = await bootServer()
  await until(() => server.mediaIndex.ready)
  const projectId = insertProject(server.db, 'local', '动态视频库项目')
  const canvasId = insertCanvas(server.db, 'local', projectId, '原始 motion 画布')
  const doc = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
  onTestFinished(() => doc.destroy())
  const video = await server.assets.ingest(
    'local',
    Readable.from([Buffer.from(MOCK_WEBM_BASE64, 'base64')]),
    { mime: 'video/webm', name: 'motion.webm' },
  )
  const asset = (owner: string, body: string | Uint8Array, mime = 'application/octet-stream') =>
    server.assets.ingest(owner, Readable.from([body]), { mime, name: 'source-fixture' })
  const source = async (title: string, owner = 'local'): Promise<CompositionSourceRef> => {
    const [bundle, dependency, manifest] = await Promise.all([
      asset(owner, zipSync({ 'index.html': strToU8(`<div>${title}</div>`) }), 'application/zip'),
      asset(owner, `dependency:${title}`),
      asset(
        owner,
        JSON.stringify({
          schema: 'plein.motion-source.v1',
          templateVersion: MOTION_TEMPLATE_VERSION,
          engine: { name: 'hyperframes', version: HYPERFRAMES_VERSION, fps: 30 },
          params: MotionParams.parse({ title }),
          inputs: {},
        }),
        'application/json',
      ),
    ])
    return {
      version: 1,
      bundleAssetId: bundle.id,
      manifestAssetId: manifest.id,
      dependencyAssetIds: [dependency.id],
      rendererIdentity: 'test/library-motion',
    }
  }
  const frozen = await source('采用版本')
  const body = {
    kind: 'effect' as const,
    name: '带动态来源的视频',
    projectId,
    video: video.id,
    videoCompositionSource: frozen,
  }
  const create = async (value: unknown = body) =>
    request(server, '/api/library', { method: 'POST', body: JSON.stringify(value) })
  const patch = async (id: string, value: unknown) =>
    request(server, `/api/library/${id}`, { method: 'PATCH', body: JSON.stringify(value) })
  return { server, projectId, canvasId, doc, video, source, frozen, body, create, patch, asset }
}

const ids = (source: CompositionSourceRef) => [
  source.bundleAssetId,
  source.manifestAssetId,
  ...source.dependencyAssetIds,
]

async function place(server: Server, item: LibraryItem, projectId: string) {
  const canvasId = insertCanvas(server.db, 'local', projectId, '复用画布')
  const ctx = serverContext({
    canvasId,
    ownerId: 'local',
    rooms: server.rooms,
    runs: server.runs,
    host: server.plugins,
    assets: server.assets,
    library: server.library,
  })
  const placed = (await placeLibraryItem.run(ctx, { item_id: item.id })) as { id: string }
  const doc = createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })
  onTestFinished(() => doc.destroy())
  return { canvasId, doc, cardId: placed.id }
}

async function exported(server: Server, projectId: string) {
  const response = await request(server, `/api/projects/${projectId}/package`)
  expect(response.status).toBe(200)
  return new Uint8Array(await response.arrayBuffer())
}

async function importPackage(server: Server, bytes: Uint8Array) {
  const preview = await request(server, '/api/project-imports', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  expect(preview.status).toBe(201)
  const result = (await preview.json()) as ProjectImportPreview
  expect(
    (await request(server, `/api/project-imports/${result.token}`, { method: 'POST' })).status,
  ).toBe(201)
}

describe('资产库参考视频的动态合成来源', () => {
  it('Create/Update 持久化精确来源；其他字段更新保留，更换视频或显式 null 清除旧来源', async () => {
    const f = await fixture()
    const response = await f.create()
    expect(response.status).toBe(201)
    const item = (await response.json()) as LibraryItem
    expect(item.videoCompositionSource).toEqual(f.frozen)
    expect(f.server.library.get('local', item.id)?.videoCompositionSource).toEqual(f.frozen)
    expect(await (await f.patch(item.id, { description: '只改描述' })).json()).toMatchObject({
      video: f.video.id,
      videoCompositionSource: f.frozen,
    })
    expect(await (await f.patch(item.id, { videoCompositionSource: null })).json()).toMatchObject({
      video: f.video.id,
    })
    expect(f.server.library.get('local', item.id)?.videoCompositionSource).toBeUndefined()
    expect((await f.patch(item.id, { videoCompositionSource: f.frozen })).status).toBe(200)
    const changed = await f.patch(item.id, { video: f.video.id })
    expect(changed.status).toBe(200)
    expect(((await changed.json()) as LibraryItem).videoCompositionSource).toBeUndefined()
    expect((await f.patch(item.id, { videoCompositionSource: f.frozen })).status).toBe(200)
    const removed = await f.patch(item.id, { video: null })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ video: null })
    expect(f.server.library.get('local', item.id)?.videoCompositionSource).toBeUndefined()
  })

  it('未声明或 null 来源的普通视频保持旧合同；声明来源必须有参考视频', async () => {
    const f = await fixture()
    expect((await f.create({ ...f.body, video: null })).status).toBe(400)
    const response = await f.create({ ...f.body, videoCompositionSource: null })
    expect(response.status).toBe(201)
    const item = (await response.json()) as LibraryItem
    expect(item.videoCompositionSource).toBeUndefined()
    expect((await f.patch(item.id, { video: null })).status).toBe(200)
    expect((await f.patch(item.id, { videoCompositionSource: f.frozen })).status).toBe(422)
    expect(f.server.library.get('local', item.id)?.video).toBeNull()
  })

  it('非法 schema 和跨 owner 来源被拒绝，库条目和源卡片均不留下半次写入', async () => {
    const f = await fixture()
    expect((await f.create({ ...f.body, videoCompositionSource: { version: 999 } })).status).toBe(
      400,
    )
    const foreign = await f.source('其他 owner 的源', 'other-owner')
    expect((await f.create({ ...f.body, videoCompositionSource: foreign })).status).toBe(422)
    expect(f.server.library.list('local')).toEqual([])
    const card = addNode(f.doc, 'plein/effect')
    const save = await request(f.server, '/api/library/save-card', {
      method: 'POST',
      body: JSON.stringify({
        canvasId: f.canvasId,
        nodeId: card,
        expectedLibraryId: null,
        snapshot: { ...f.body, videoCompositionSource: foreign },
      }),
    })
    expect(save.status).toBe(422)
    expect(await save.text()).not.toContain(foreign.manifestAssetId)
    expect(f.server.library.list('local')).toEqual([])
    expect(f.doc.get(card)?.params?.libraryId).toBeUndefined()
    const own = f.server.library.create('local', CreateLibraryItem.parse(f.body))
    const update = await f.patch(own.id, { videoCompositionSource: foreign })
    expect(update.status).toBe(422)
    expect(f.server.library.get('local', own.id)?.videoCompositionSource).toEqual(f.frozen)
  })

  it('Save 从采用候选冻结来源；删原节点后仅库引用仍保护源依赖并支持素材来源发现', async () => {
    const f = await fixture()
    const node = addNode(f.doc, 'plein/motion')
    const card = addNode(f.doc, 'plein/effect')
    const candidate = (id: string, source: CompositionSourceRef) => ({
      id,
      runId: `run_${id}`,
      port: 'video',
      at: Date.now(),
      value: { type: 'video' as const, assetId: f.video.id, compositionSource: source },
    })
    addResults(f.doc, node, [candidate('adopted', f.frozen)])
    addResults(f.doc, node, [candidate('unadopted', await f.source('未采用版本'))], {
      adopt: false,
    })
    expect(connect(f.doc, [node, 'video'], [card, 'references'])).toBeTruthy()
    const snapshot = cardSnapshot(f.doc, f.doc.get(card)!, f.projectId)!.body
    expect(snapshot.videoCompositionSource).toEqual(f.frozen)
    const saved = await request(f.server, '/api/library/save-card', {
      method: 'POST',
      body: JSON.stringify({
        canvasId: f.canvasId,
        nodeId: card,
        expectedLibraryId: null,
        snapshot,
      }),
    })
    expect(saved.status).toBe(200)
    const { item } = (await saved.json()) as SaveLibraryCardResult
    expect(item.videoCompositionSource).toEqual(f.frozen)
    deleteElements(f.doc, [node, card])
    for (const id of ids(f.frozen))
      expect(f.server.mediaIndex.sources('local', id, { limit: 50 }).items).toContainEqual(
        expect.objectContaining({ type: 'library', id: item.id }),
      )
    const found = await request(f.server, `/api/motion/asset/${f.video.id}/sources`)
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({
      sources: [{ compositionSource: f.frozen, title: '采用版本' }],
    })
    expect((await f.server.maintenance!.preview()).protectedAssets).toBe(4)
  })

  it('跨画布 Agent place 保留精确来源；删除库后检查点仍固定源并可恢复', async () => {
    const f = await fixture()
    const item = f.server.library.create('local', CreateLibraryItem.parse(f.body))
    const target = await place(f.server, item, f.projectId)
    expect(referenceMedia(target.doc, target.doc.get(target.cardId)!, 'video')).toEqual([
      { assetId: f.video.id, compositionSource: f.frozen },
    ])
    expect(
      cardSnapshot(target.doc, target.doc.get(target.cardId)!, f.projectId)!.body
        .videoCompositionSource,
    ).toEqual(f.frozen)
    f.server.library.remove('local', item.id)
    const saved = f.server.checkpoints.create('local', target.canvasId, {
      name: '库删除后的精确源',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(target.doc.ydoc))).toString(
        'base64',
      ),
    })
    for (const id of ids(f.frozen))
      expect(
        f.server.db.$client
          .prepare('SELECT asset_id FROM checkpoint_assets WHERE checkpoint_id=? AND asset_id=?')
          .get(saved.id, id),
      ).toEqual({ asset_id: id })
    expect(
      (await request(f.server, `/api/canvases/${target.canvasId}`, { method: 'DELETE' })).status,
    ).toBe(204)
    const restored = f.server.checkpoints.restore('local', saved.id)
    f.server.rooms.withDoc(restored.canvasId, (doc) => {
      expect(referenceMedia(doc, doc.get(target.cardId)!, 'video')).toEqual([
        { assetId: f.video.id, compositionSource: f.frozen },
      ])
      expect(compositionReferences(doc).sort()).toEqual(ids(f.frozen).sort())
    })
  })

  it('仅保留库条目的项目包完整迁移来源；包漏声明源依赖时硬失败', async () => {
    const f = await fixture()
    f.server.library.create('local', CreateLibraryItem.parse(f.body))
    expect(
      (await request(f.server, `/api/canvases/${f.canvasId}`, { method: 'DELETE' })).status,
    ).toBe(204)
    const bytes = await exported(f.server, f.projectId)
    const files = unzipSync(bytes)
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as ProjectPackageManifest
    expect(manifest.library[0]?.videoCompositionSource).toEqual(f.frozen)
    expect(manifest.assets.map((asset) => asset.id)).toEqual(
      expect.arrayContaining([f.video.id, ...ids(f.frozen)]),
    )
    const target = (await bootServer()).server
    await importPackage(target, bytes)
    const imported = target.library.list('local')[0]!
    expect(imported.videoCompositionSource).toEqual(f.frozen)
    for (const id of ids(f.frozen)) await target.assets.verifyOriginal('local', id)
    const placed = await place(target, imported, imported.projectId!)
    expect(
      referenceMedia(placed.doc, placed.doc.get(placed.cardId)!, 'video')[0]?.compositionSource,
    ).toEqual(f.frozen)
    const omitted = manifest.assets.find((asset) => asset.id === f.frozen.dependencyAssetIds[0])!
    manifest.assets = manifest.assets.filter((asset) => asset.id !== omitted.id)
    delete files[omitted.file.path]
    files['manifest.json'] = strToU8(JSON.stringify(manifest))
    const rejected = await request(target, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: zipSync(files),
    })
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toHaveProperty('error', 'missing_file')
  })

  it.each(['bundleAssetId', 'manifestAssetId', 'dependencyAssetIds'] as const)(
    '新建和项目包不允许 %s 物理原件缺失而静默丢源',
    async (key) => {
      const f = await fixture()
      const item = f.server.library.create('local', CreateLibraryItem.parse(f.body))
      const id = key === 'dependencyAssetIds' ? f.frozen[key][0]! : f.frozen[key]
      const path = f.server.assets.originalPath(id)
      renameSync(path, `${path}.missing`)
      expect((await f.create()).status).toBe(422)
      expect((await f.patch(item.id, { description: '来源已缺失' })).status).toBe(422)
      const response = await request(f.server, `/api/projects/${f.projectId}/package`)
      expect(response.status).toBe(422)
      expect(await response.json()).toHaveProperty('error', 'missing_file')
    },
  )

  it('相同 video 改来源也产生 references 差异；确认同步时写入新版精确来源', async () => {
    const f = await fixture()
    const item = f.server.library.create('local', CreateLibraryItem.parse(f.body))
    const target = await place(f.server, item, f.projectId)
    const newer = await f.source('相同视频的新源版本')
    f.server.library.update('local', item.id, { videoCompositionSource: newer })
    const read = await request(f.server, `/api/library/${item.id}/updates`)
    expect(read.status).toBe(200)
    const changes = (await read.json()) as LibraryUpdates
    const card = changes.cards.find((card) => card.nodeId === target.cardId)!
    expect(card.changes.map((change) => change.field)).toContain('references')
    const applied = await request(f.server, `/api/library/${item.id}/updates`, {
      method: 'POST',
      body: JSON.stringify({
        revision: changes.revision,
        targets: [{ ...card, mode: 'update', fields: ['references'] }],
      }),
    })
    expect(applied.status).toBe(200)
    const edge = inputEdges(target.doc, target.cardId, 'references')[0]!
    expect(target.doc.get(edge.from[0])?.params?.compositionSource).toEqual(newer)
    expect(referenceMedia(target.doc, target.doc.get(target.cardId)!, 'video')).toEqual([
      { assetId: f.video.id, compositionSource: newer },
    ])
    const unchanged = await request(f.server, `/api/library/${item.id}/updates`)
    expect(((await unchanged.json()) as LibraryUpdates).cards[0]?.changes).toEqual([])
  })
})

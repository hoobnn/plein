import { Readable } from 'node:stream'
import { unlinkSync } from 'node:fs'
import { Hono } from 'hono'
import { strFromU8, unzipSync } from 'fflate'
import { expect, it, vi } from 'vite-plus/test'
import { panoramaSceneRevision } from '@plein/nodes'
import {
  CreateLibraryItem,
  type Canvas,
  type ProjectPackageManifest,
  type ProjectImportPreview,
  type ProjectImportResult,
} from '@plein/protocol'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { documentReferences } from '../media-index/references'
import { addNode, bootServer, createCanvas, request } from '../testing'
import type { AuthEnv } from '../auth'
import { librarySyncRoutes } from './sync'
import { capturePanoramaView } from './panorama'

async function fixture() {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const source = await server.assets.ingest(
    'local',
    Readable.from([solidPng(128, 64, [40, 70, 120])]),
    { mime: 'image/png', name: 'panorama.png' },
  )
  const item = server.library.create(
    'local',
    CreateLibraryItem.parse({
      kind: 'scene',
      name: '全景测试',
      description: '保留的场景设定',
      images: [{ slot: 'panorama', assetId: source.id }],
    }),
  )
  const input = {
    sourceAssetId: source.id,
    expected: panoramaSceneRevision(item),
    name: '门口',
    description: '看向门口',
    pose: { yaw: 90, pitch: 10, fov: 55, format: 'landscape' },
  }
  const capture = (
    body: unknown = input,
    signal = new AbortController().signal,
    canWrite = () => true,
  ) => capturePanoramaView(server.assets, server.library, 'local', item.id, body, signal, canWrite)
  return { server, canvasId, doc, source, item, input, capture }
}
it('从原全景按姿态生成新PNG并只追加命名视角，重放旧确认冲突', async () => {
  const f = await fixture()
  const saved = await f.capture()
  expect(saved).toMatchObject({
    name: f.item.name,
    description: f.item.description,
    projectId: f.item.projectId,
    images: f.item.images,
  })
  expect(saved.sceneViews).toHaveLength(1)
  const view = saved.sceneViews![0]!
  expect(view).toMatchObject({ name: '门口', panorama: { assetId: f.source.id, ...f.input.pose } })
  const image = f.server.assets.get('local', view.images[0]!)!
  expect(image).toMatchObject({ kind: 'image', mime: 'image/png', width: 1024, height: 576 })
  expect(image.id).not.toBe(f.source.id)
  await expect(f.capture()).rejects.toMatchObject({ status: 409 })
})
it('拒绝viewer、其他所有者、无效参数与同毫秒内容变更', async () => {
  const f = await fixture()
  const app = new Hono<AuthEnv>()
    .use('*', (c, next) => {
      c.set('principal', { id: 'local', role: 'viewer' })
      return next()
    })
    .route(
      '/',
      librarySyncRoutes({
        db: f.server.db,
        rooms: f.server.rooms,
        assets: f.server.assets,
        library: f.server.library,
      }),
    )
  expect(
    (
      await app.request(`/api/library/${f.item.id}/panorama-view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(f.input),
      })
    ).status,
  ).toBe(403)
  await expect(
    capturePanoramaView(
      f.server.assets,
      f.server.library,
      'other',
      f.item.id,
      f.input,
      new AbortController().signal,
      () => true,
    ),
  ).rejects.toMatchObject({ status: 404 })
  await expect(f.capture({ ...f.input, pose: { ...f.input.pose, fov: 0 } })).rejects.toMatchObject({
    status: 400,
  })
  f.server.library.update('local', f.item.id, { description: '并发新内容' })
  f.server.db.$client
    .prepare('UPDATE library_items SET updated_at=? WHERE id=?')
    .run(f.item.updatedAt, f.item.id)
  await expect(f.capture()).rejects.toMatchObject({ status: 409 })
})
it.each(['changed', 'cancelled', 'permission', 'deleted-source'] as const)(
  '投影异步完成后%s不写入旧目标',
  async (mode) => {
    const f = await fixture()
    const controller = new AbortController()
    let writable = true
    const ingest = f.server.assets.ingest.bind(f.server.assets)
    vi.spyOn(f.server.assets, 'ingest').mockImplementationOnce(async (...args) => {
      const asset = await ingest(...args)
      if (mode === 'changed')
        f.server.library.update('local', f.item.id, { description: '异步期间修改' })
      if (mode === 'cancelled') controller.abort()
      if (mode === 'permission') writable = false
      if (mode === 'deleted-source') unlinkSync(f.server.assets.originalPath(f.source.id))
      return asset
    })
    await expect(f.capture(f.input, controller.signal, () => writable)).rejects.toThrow()
    expect(f.server.library.get('local', f.item.id)?.sceneViews ?? []).toEqual([])
  },
)
it('限制原图像素与普通宽图，避免开始不受限解码或把方图当作全景', async () => {
  const f = await fixture()
  f.server.db.$client
    .prepare('UPDATE assets SET width=10000,height=5000 WHERE id=?')
    .run(f.source.id)
  await expect(f.capture()).rejects.toMatchObject({ status: 400 })
  f.server.db.$client.prepare('UPDATE assets SET width=128,height=64 WHERE id=?').run(f.source.id)
  const square = await f.server.assets.ingest(
    'local',
    Readable.from([solidPng(64, 64, [40, 80, 100])]),
    { mime: 'image/png', name: 'square.png' },
  )
  const item = f.server.library.update('local', f.item.id, {
    images: [{ slot: 'panorama', assetId: square.id }],
  })!
  await expect(
    f.capture({ ...f.input, sourceAssetId: square.id, expected: panoramaSceneRevision(item) }),
  ).rejects.toMatchObject({ status: 400 })
})
it('只保留视角来源时仍强引用原图；模型只用截图；普通保存与项目包往返保留出处', async () => {
  const f = await fixture()
  const saved = await f.capture()
  const view = saved.sceneViews![0]!
  const patch = await request(f.server, `/api/library/${f.item.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ images: [], sceneViews: saved.sceneViews }),
  })
  expect(patch.status).toBe(200)
  const scene = addNode(f.doc, 'plein/scene', {
    name: '全景测试',
    params: { libraryId: f.item.id, sceneViews: saved.sceneViews },
  })
  const node = addNode(f.doc, 'plein/image', { params: { prompt: '@全景测试/门口' } })
  expect(documentReferences(f.doc).filter((ref) => ref.assetId === f.source.id)).toContainEqual(
    expect.objectContaining({ explicit: true }),
  )
  const prepared = (await (
    await request(f.server, `/api/canvases/${f.canvasId}/nodes/${node}/input`)
  ).json()) as { inputs: { references: { assetId: string }[] } }
  expect(prepared.inputs.references.map((ref) => ref.assetId)).toEqual(view.images)
  const canvas = (await (await request(f.server, `/api/canvases/${f.canvasId}`)).json()) as Canvas
  const zip = await request(f.server, `/api/projects/${canvas.projectId}/package`)
  expect(zip.status).toBe(200)
  const bytes = new Uint8Array(await zip.arrayBuffer())
  const manifest = JSON.parse(
    strFromU8(unzipSync(bytes)['manifest.json']!),
  ) as ProjectPackageManifest
  expect(manifest.assets.map((asset) => asset.id)).toContain(f.source.id)
  const inspect = await request(f.server, '/api/project-imports', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  expect(inspect.status).toBe(201)
  const preview = (await inspect.json()) as ProjectImportPreview
  const commit = await request(f.server, `/api/project-imports/${preview.token}`, {
    method: 'POST',
    body: '{}',
  })
  expect(commit.status).toBe(201)
  const imported = (await commit.json()) as ProjectImportResult
  if (!imported.canvasId) throw new Error('导入缺少画布')
  const restored = f.server.rooms.withDoc(imported.canvasId, (doc) => doc.get(scene))!
  expect(restored.params?.sceneViews).toEqual(saved.sceneViews)
})

it('拒绝视角旧名冲突和24个视角上限，保留已有档案', async () => {
  const f = await fixture()
  const collision = f.server.library.update('local', f.item.id, {
    sceneViews: [{ id: 'one', name: '新版门口', aliases: ['门口'], description: '', images: [] }],
  })!
  await expect(
    f.capture({ ...f.input, expected: panoramaSceneRevision(collision) }),
  ).rejects.toMatchObject({ status: 409 })
  const views = Array.from({ length: 24 }, (_, i) => ({
    id: String(i),
    name: `视角${i}`,
    aliases: [],
    description: '',
    images: [],
  }))
  const full = f.server.library.update('local', f.item.id, { sceneViews: views })!
  await expect(
    f.capture({ ...f.input, expected: panoramaSceneRevision(full), name: '新机位' }),
  ).rejects.toMatchObject({ status: 409 })
  expect(f.server.library.get('local', f.item.id)?.sceneViews).toEqual(views)
})

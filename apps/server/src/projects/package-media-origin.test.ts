import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createElement, deleteElements } from '@plein/doc'
import {
  MediaDerivationOrigin,
  type Canvas,
  type ProjectImportPreview,
  type ProjectImportResult,
  type ProjectPackageManifest,
} from '@plein/protocol'
import { strFromU8, unzipSync } from 'fflate'
import * as Y from 'yjs'
import { expect, it } from 'vite-plus/test'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { deriveAsset } from '../assets/derive'
import { hasFfmpeg } from '../assets/media'
import { createCheckpointService } from '../checkpoints/service'
import { documentReferences } from '../media-index/references'
import { bootServer, createCanvas, request, tempDir, until } from '../testing'

const native = await hasFfmpeg()
const OWNER = 'local'

async function videoFixture() {
  const context = await bootServer()
  const { server } = context
  const { id: canvasId, doc } = await createCanvas(server)
  const canvas = (await (await request(server, `/api/canvases/${canvasId}`)).json()) as Canvas
  const dir = tempDir('plein-package-media-fixture-')
  const assets = []
  for (const [index, color] of ['blue', 'red'].entries()) {
    const file = join(dir, `${index}.mp4`)
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=${color}:s=160x90:r=10:d=1`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      file,
    ])
    const { createReadStream } = await import('node:fs')
    assets.push(
      await server.assets.ingest(OWNER, createReadStream(file), {
        mime: 'video/mp4',
        name: `${color}.mp4`,
      }),
    )
  }
  const [source, replacement] = assets
  const made = await deriveAsset(server.assets, OWNER, {
    op: 'replace-range',
    assetId: source!.id,
    replacementAssetId: replacement!.id,
    start: 0.3,
    end: 0.7,
    replacementStart: 0,
  })
  const origin = MediaDerivationOrigin.parse({
    version: 1,
    op: made.op,
    source: made.source,
    params: made.params,
  })
  const sourceElement = createElement(doc, {
    kind: 'video',
    assetId: source!.id,
    x: 0,
    y: 0,
    w: 160,
    h: 90,
  })
  const replacementElement = createElement(doc, {
    kind: 'video',
    assetId: replacement!.id,
    x: 200,
    y: 0,
    w: 160,
    h: 90,
  })
  const result = createElement(doc, {
    kind: 'video',
    assetId: made.assets[0]!.id,
    params: { mediaDerivation: origin },
    x: 400,
    y: 0,
    w: 160,
    h: 90,
  })
  deleteElements(doc, [sourceElement, replacementElement])
  return {
    ...context,
    doc,
    canvasId,
    projectId: canvas.projectId,
    result,
    origin,
    ids: [source!.id, replacement!.id, made.assets[0]!.id],
  }
}

it.skipIf(!native).each([true, false])(
  '派生结果%s保留在当前画布时，删除输入元素后GC与项目包仍保留两输入，导入后可恢复检查点',
  async (keepCurrent) => {
    const f = await videoFixture()
    expect([...f.doc.elements()]).toHaveLength(1)
    const strong = new Set(
      documentReferences(f.doc)
        .filter((ref) => ref.explicit)
        .map((ref) => ref.assetId),
    )
    expect([...strong].sort()).toEqual([...f.ids].sort())
    const checkpoints = createCheckpointService({
      db: f.server.db,
      rooms: f.server.rooms,
      assets: f.server.assets,
      index: f.server.mediaIndex,
    })
    const cp = checkpoints.create(OWNER, f.canvasId, {
      name: '只剩加工产物',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(f.doc.ydoc))).toString('base64'),
    })
    expect(
      f.server.db.$client
        .prepare('SELECT asset_id FROM checkpoint_assets WHERE checkpoint_id=?')
        .all(cp.id),
    ).toEqual(expect.arrayContaining(f.ids.map((asset_id) => ({ asset_id }))))
    if (!keepCurrent) deleteElements(f.doc, [f.result])
    // 把输入与未引用对照素材都置为过期，证明保护来自持久引用而非“素材太新”。
    const unused = await f.server.assets.ingest(OWNER, Readable.from(['unused-control']), {
      mime: 'application/octet-stream',
      name: 'unused-control.bin',
    })
    const aged = new Date(Date.now() - 90 * 86400000)
    for (const id of [...f.ids, unused.id]) {
      f.server.db.$client
        .prepare('UPDATE assets SET created_at=? WHERE id=?')
        .run(aged.getTime(), id)
      const folder = dirname(f.server.assets.originalPath(id))
      for (const name of await readdir(folder))
        if (name.startsWith(id)) await utimes(join(folder, name), aged, aged)
    }
    f.server.rooms.get(f.canvasId).flush()
    await until(() => !f.server.assets.activity.busy)
    const preview = await f.server.maintenance!.preview()
    expect(preview.assets).toBe(1)
    expect(preview.protectedAssets).toBe(3)
    const cleaned = await f.server.maintenance!.cleanup(preview.token)
    expect(cleaned.assets).toBe(1)
    expect(existsSync(f.server.assets.originalPath(unused.id))).toBe(false)
    for (const id of f.ids) expect(existsSync(f.server.assets.originalPath(id))).toBe(true)

    const response = await request(f.server, `/api/projects/${f.projectId}/package`)
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const zip = unzipSync(bytes)
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as ProjectPackageManifest
    expect(manifest.missing).toEqual([])
    expect(manifest.assets.map((asset) => asset.id).sort()).toEqual([...f.ids].sort())
    expect(manifest.checkpoints).toHaveLength(1)
    for (const id of f.ids)
      expect(zip[`assets/${id}`]).toEqual(await f.server.assets.readOriginal(OWNER, id))

    const target = await bootServer({ dataDir: tempDir('plein-package-media-import-') })
    const inspect = await request(target.server, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    expect(inspect.status).toBe(201)
    const importedPreview = (await inspect.json()) as ProjectImportPreview
    const commit = await request(target.server, `/api/project-imports/${importedPreview.token}`, {
      method: 'POST',
      body: '{}',
    })
    expect(commit.status).toBe(201)
    const imported = (await commit.json()) as ProjectImportResult
    if (!imported.canvasId) throw new Error('导入没有恢复画布')
    const current = target.server.rooms.withDoc(imported.canvasId, (doc) => doc.get(f.result))
    if (keepCurrent) expect(current?.params?.mediaDerivation).toEqual(f.origin)
    else expect(current).toBeUndefined()
    const migrated = createCheckpointService({
      db: target.server.db,
      rooms: target.server.rooms,
      assets: target.server.assets,
      index: target.server.mediaIndex,
    })
    const restored = migrated.restore(
      OWNER,
      migrated.list(OWNER, imported.projectId, { limit: 50 }).items[0]!.id,
    )
    const element = target.server.rooms.withDoc(restored.canvasId, (doc) => doc.get(f.result))!
    expect(element.params?.mediaDerivation).toEqual(f.origin)
    expect(element.assetId).toBe(f.ids[2])
    for (const id of f.ids)
      expect(await target.server.assets.readOriginal(OWNER, id)).toEqual(
        await f.server.assets.readOriginal(OWNER, id),
      )
  },
  30000,
)

it.each([true, false])('缺失输入的%s来源仅在schema有效时成为显式引用并报告缺失', async (valid) => {
  const { server } = await bootServer()
  const { id: canvasId, doc } = await createCanvas(server)
  const canvas = (await (await request(server, `/api/canvases/${canvasId}`)).json()) as Canvas
  const carrier = await server.assets.ingest(
    OWNER,
    Readable.from([solidPng(16, 16, [40, 90, 120])]),
    { mime: 'image/png', name: 'carrier.png' },
  )
  const source = 'e'.repeat(64),
    replacement = 'f'.repeat(64)
  const origin = {
    version: 1,
    op: 'replace-range',
    source: { assetId: source, kind: 'video', name: 'missing.mp4' },
    params: {
      replacementAssetId: replacement,
      start: 0,
      end: 1,
      replacementStart: 0,
      frameRate: 25,
      frames: 25,
      audio: 'source',
      fit: 'contain',
      ...(!valid ? { unknownHash: 'd'.repeat(64) } : {}),
    },
  }
  createElement(doc, {
    kind: 'image',
    assetId: carrier.id,
    params: { mediaDerivation: origin },
    x: 0,
    y: 0,
    w: 16,
    h: 16,
  })
  const refs = documentReferences(doc).filter(
    (ref) => [source, replacement].includes(ref.assetId) && ref.explicit,
  )
  expect(refs.map((ref) => ref.assetId).sort()).toEqual(valid ? [source, replacement] : [])
  const response = await request(server, `/api/projects/${canvas.projectId}/package`)
  expect(response.status).toBe(200)
  const manifest = JSON.parse(
    strFromU8(unzipSync(new Uint8Array(await response.arrayBuffer()))['manifest.json']!),
  ) as ProjectPackageManifest
  expect(manifest.missing.map((item) => item.id).sort()).toEqual(valid ? [source, replacement] : [])
})

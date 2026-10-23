import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'
import { Readable } from 'node:stream'
import {
  addResults,
  adoptResult,
  compositionAssetIds,
  createDoc,
  createElement,
  deleteElements,
  currentResult,
  MAX_RESULTS,
  setParam,
  type NodeResult,
} from '@plein/doc'
import type { CompositionSourceRef } from '@plein/plugin-sdk'
import type {
  Canvas,
  ProjectImportPreview,
  ProjectImportResult,
  ProjectPackageManifest,
} from '@plein/protocol'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import * as Y from 'yjs'
import { describe, expect, it } from 'vite-plus/test'
import type { Server } from '../app'
import { checkpointAssetIds } from '../checkpoints/archive'
import { documentReferences } from '../media-index/references'
import { addNode, bootServer, createCanvas, request, until } from '../testing'

async function seed() {
  const { server } = await bootServer()
  await until(() => server.mediaIndex.ready)
  const { id: canvasId, doc } = await createCanvas(server)
  const canvas = (await (await request(server, `/api/canvases/${canvasId}`)).json()) as Canvas
  const nodeId = addNode(doc, 'plein/motion', { params: { title: '尚未修改' } })
  const asset = async (name: string, owner = 'local') =>
    server.assets.ingest(owner, Readable.from([name]), { mime: 'application/octet-stream', name })
  async function candidate(name: string): Promise<NodeResult> {
    const [video, bundle, manifest, dependency] = await Promise.all([
      asset(`${name}-video`),
      asset(`${name}-bundle`),
      asset(`${name}-manifest`),
      asset(`${name}-dependency`),
    ])
    const compositionSource: CompositionSourceRef = {
      version: 1,
      bundleAssetId: bundle.id,
      manifestAssetId: manifest.id,
      dependencyAssetIds: [dependency.id],
      rendererIdentity: 'hyperframes@0.8.186/test',
    }
    return {
      id: `res_${name}`,
      runId: `run_${name}`,
      port: 'video',
      at: Date.now(),
      value: { type: 'video', assetId: video.id, compositionSource },
    }
  }
  const older = await candidate('older')
  const newer = await candidate('newer')
  addResults(doc, nodeId, [older])
  addResults(doc, nodeId, [newer], { adopt: false })
  setParam(doc, nodeId, 'title', '当前参数已修改，尚未重新渲染')
  server.rooms.get(canvasId).flush()
  const save = () =>
    server.checkpoints.create('local', canvasId, {
      name: '两个来源候选',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
    })
  return {
    server,
    canvasId,
    projectId: canvas.projectId,
    doc,
    nodeId,
    asset,
    candidate,
    older,
    newer,
    save,
  }
}

function sourceOf(result: NodeResult) {
  if (!('assetId' in result.value)) throw new Error('expected media')
  return result.value.compositionSource!
}
function assetOf(result: NodeResult) {
  if (!('assetId' in result.value)) throw new Error('expected media')
  return result.value.assetId
}
async function download(server: Server, projectId: string, all = false) {
  const response = await request(
    server,
    `/api/projects/${projectId}/package${all ? '?history=1' : ''}`,
  )
  expect(response.status).toBe(200)
  return new Uint8Array(await response.arrayBuffer())
}
function manifestOf(bytes: Uint8Array) {
  return JSON.parse(strFromU8(unzipSync(bytes)['manifest.json']!)) as ProjectPackageManifest
}
async function importInto(server: Server, bytes: Uint8Array) {
  const previewResponse = await request(server, '/api/project-imports', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  expect(previewResponse.status).toBe(201)
  const preview = (await previewResponse.json()) as ProjectImportPreview
  const committed = await request(server, `/api/project-imports/${preview.token}`, {
    method: 'POST',
  })
  expect(committed.status).toBe(201)
  return (await committed.json()) as ProjectImportResult
}

/** 移除一个声明及文件，模拟旧导出器未收集嵌套来源；其余清单与哈希仍然有效。 */
function omitAsset(bytes: Uint8Array, id: string) {
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as ProjectPackageManifest
  const asset = manifest.assets.find((entry) => entry.id === id)!
  manifest.assets = manifest.assets.filter((entry) => entry.id !== id)
  delete files[asset.file.path]
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  return zipSync(files)
}

/** 候选字段不是单独schema文件，也要防止损坏的来源被忽略而通过导入。 */
function malformedSource(bytes: Uint8Array) {
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as ProjectPackageManifest
  const canvas = manifest.canvases[0]!
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, files[canvas.file.path]!)
  const elements = ydoc.getMap<Y.Map<unknown>>('elements')
  for (const element of elements.values()) {
    const results = element.get('results') as NodeResult[] | undefined
    if (results?.length)
      element.set(
        'results',
        results.map((result) => ({
          ...result,
          value: { ...result.value, compositionSource: { version: 999 } },
        })),
      )
  }
  const state = Y.encodeStateAsUpdate(ydoc)
  files[canvas.file.path] = new Uint8Array(state)
  canvas.file.sha256 = createHash('sha256').update(state).digest('hex')
  canvas.file.size = state.byteLength
  files['manifest.json'] = strToU8(JSON.stringify(manifest))
  ydoc.destroy()
  return zipSync(files)
}

describe('动态合成来源生命周期', () => {
  it('改变当前参数不改变旧候选的显式来源；索引按候选身份标记采用', async () => {
    const s = await seed()
    const refs = documentReferences(s.doc)
    for (const result of [s.older, s.newer]) {
      for (const id of compositionAssetIds(sourceOf(result))) {
        expect(refs).toContainEqual(
          expect.objectContaining({
            assetId: id,
            explicit: true,
            resultId: result.id,
            adopted: result.id === s.older.id,
          }),
        )
        const indexed = s.server.mediaIndex.sources('local', id, { limit: 50 }).items
        expect(indexed).toContainEqual(
          expect.objectContaining({ type: 'canvas', resultId: result.id }),
        )
      }
    }
    expect(sourceOf(s.doc.get(s.nodeId)!.results![1]!)).toEqual(sourceOf(s.older))
    s.doc.destroy()
  })

  it('检查点固定两个来源，删除当前候选后恢复仍保留旧参数和完整来源', async () => {
    const s = await seed()
    const cp = s.save()
    const expected = [s.older, s.newer]
      .flatMap((result) => [assetOf(result), ...compositionAssetIds(sourceOf(result))])
      .sort()
    const pins = s.server.db.$client
      .prepare('SELECT asset_id FROM checkpoint_assets WHERE checkpoint_id=?')
      .all(cp.id) as Array<{ asset_id: string }>
    expect(pins.map((row) => row.asset_id).sort()).toEqual(expected)
    s.doc.ydoc.transact(() => s.doc.mutable(s.nodeId)!.set('results', [s.older]), s.doc.origin)
    setParam(s.doc, s.nodeId, 'title', '检查点之后')
    const restored = s.server.checkpoints.restore('local', cp.id)
    const recovered = createDoc(s.server.rooms.get(restored.canvasId).doc, { schedule: () => {} })
    expect(recovered.get(s.nodeId)?.params?.title).toBe('当前参数已修改，尚未重新渲染')
    expect(recovered.get(s.nodeId)?.results?.map((result) => sourceOf(result))).toEqual([
      sourceOf(s.newer),
      sourceOf(s.older),
    ])
    expect(recovered.get(s.nodeId)?.results?.[0]?.runId).not.toBe(s.newer.runId)
    recovered.destroy()
    s.doc.destroy()
  })

  it.each([false, true])(
    '项目包采用/全部策略 %s 保留对应候选源，导入和复制导入不strip元数据',
    async (all) => {
      const s = await seed()
      const bytes = await download(s.server, s.projectId, all)
      const manifest = manifestOf(bytes)
      const kept = all ? [s.older, s.newer] : [s.older]
      const ids = manifest.assets.map((asset) => asset.id)
      for (const result of kept)
        expect(ids).toEqual(
          expect.arrayContaining([assetOf(result), ...compositionAssetIds(sourceOf(result))]),
        )
      if (!all)
        for (const id of compositionAssetIds(sourceOf(s.newer))) expect(ids).not.toContain(id)
      const target = (await bootServer()).server
      for (let repeat = 0; repeat < 2; repeat++) {
        const imported = await importInto(target, bytes)
        const restored = createDoc(target.rooms.get(imported.canvasId!).doc, { schedule: () => {} })
        const results = restored.get(s.nodeId)!.results!
        expect(results.map((result) => sourceOf(result))).toEqual(
          all ? [sourceOf(s.newer), sourceOf(s.older)] : [sourceOf(s.older)],
        )
        for (const result of results)
          for (const id of compositionAssetIds(sourceOf(result)))
            await expect(target.assets.verifyOriginal('local', id)).resolves.toHaveProperty(
              'id',
              id,
            )
        restored.destroy()
      }
      s.doc.destroy()
    },
  )

  it('当前候选包仍完整迁移命名检查点中的未采用来源', async () => {
    const s = await seed()
    const checkpoint = s.save()
    const bytes = await download(s.server, s.projectId)
    expect(manifestOf(bytes).assets.map((asset) => asset.id)).toEqual(
      expect.arrayContaining(compositionAssetIds(sourceOf(s.newer))),
    )
    const target = (await bootServer()).server
    const imported = await importInto(target, bytes)
    const checkpoints = target.checkpoints.list('local', imported.projectId, { limit: 50 }).items
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]?.name).toBe(checkpoint.name)
    const restored = target.checkpoints.restore('local', checkpoints[0]!.id)
    const recovered = createDoc(target.rooms.get(restored.canvasId).doc, { schedule: () => {} })
    expect(recovered.get(s.nodeId)?.results?.map((result) => sourceOf(result))).toEqual([
      sourceOf(s.newer),
      sourceOf(s.older),
    ])
    recovered.destroy()
    s.doc.destroy()
  })

  it.each(['bundleAssetId', 'manifestAssetId', 'dependencyAssetIds'] as const)(
    '任何来源部分 %s 缺失都拒绝保存/导出/恢复，普通媒体missing合同仍保留',
    async (field) => {
      const s = await seed()
      const checkpoint = s.save()
      const source = sourceOf(s.older)
      const id = field === 'dependencyAssetIds' ? source.dependencyAssetIds[0]! : source[field]
      const path = s.server.assets.originalPath(id)
      renameSync(path, `${path}.missing`)
      expect(() => s.save()).toThrow('动态合成')
      expect(() => s.server.checkpoints.restore('local', checkpoint.id)).toThrow('动态合成')
      for (const suffix of ['package', 'package/summary']) {
        const response = await request(s.server, `/api/projects/${s.projectId}/${suffix}`)
        expect(response.status).toBe(422)
        expect(await response.json()).toMatchObject({ error: 'missing_file' })
      }
      s.doc.destroy()
    },
  )

  it('包中遗漏来源声明不能借目标安装已存在素材绕过自包含校验；损坏来源合同也拒绝', async () => {
    const s = await seed()
    const bytes = await download(s.server, s.projectId)
    const source = sourceOf(s.older)
    const inputs = [source.bundleAssetId, source.manifestAssetId, ...source.dependencyAssetIds]
    for (const id of inputs) {
      const response = await request(s.server, '/api/project-imports', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: omitAsset(bytes, id),
      })
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ error: 'missing_file' })
    }
    const invalid = await request(s.server, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: malformedSource(bytes),
    })
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({ error: 'corrupt' })
    s.doc.destroy()
  })

  it('检查点独有来源遗漏也阻断导入；普通旧媒体缺失仍可按原合同迁移', async () => {
    const s = await seed()
    s.save()
    const bytes = await download(s.server, s.projectId)
    const omitted = omitAsset(bytes, sourceOf(s.newer).bundleAssetId)
    const rejected = await request(s.server, '/api/project-imports', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: omitted,
    })
    expect(rejected.status).toBe(422)
    expect(await rejected.json()).toMatchObject({ error: 'missing_file' })
    const oldCanvas = await createCanvas(s.server)
    addNode(oldCanvas.doc, 'plein/video', { params: { model: 'plein/mock:video' } })
    const plain = oldCanvas.doc.elements().next().value!
    addResults(oldCanvas.doc, plain.id, [
      {
        id: 'missing_legacy',
        runId: 'legacy_run',
        port: 'video',
        at: Date.now(),
        value: { type: 'video', assetId: 'f'.repeat(64) },
      },
    ])
    const canvas = (await (
      await request(s.server, `/api/canvases/${oldCanvas.id}`)
    ).json()) as Canvas
    const oldBytes = await download(s.server, canvas.projectId)
    expect(manifestOf(oldBytes).missing).toContainEqual(
      expect.objectContaining({ id: 'f'.repeat(64) }),
    )
    const target = (await bootServer()).server
    const imported = await importInto(target, oldBytes)
    expect(imported.projectId).toBeTruthy()
    oldCanvas.doc.destroy()
    s.doc.destroy()
  })

  it('不同owner的源文件既不入索引、pin或项目包，也不在错误中泄露元数据', async () => {
    const s = await seed()
    const secret = await s.asset('foreign-secret-source-name', 'other')
    const source = { ...sourceOf(s.older), bundleAssetId: secret.id }
    const result = { ...s.older, value: { ...s.older.value, compositionSource: source } }
    s.doc.ydoc.transact(() => s.doc.mutable(s.nodeId)!.set('results', [result]), s.doc.origin)
    s.server.rooms.get(s.canvasId).flush()
    expect(() => s.server.mediaIndex.sources('local', secret.id, { limit: 50 })).toThrow(
      '素材不存在',
    )
    const refs = checkpointAssetIds(
      Y.encodeStateAsUpdate(s.doc.ydoc),
      (id) => !!s.server.assets.get('local', id),
    )
    expect(refs.ids).not.toContain(secret.id)
    expect(refs.missing).toContain(secret.id)
    expect(() => s.save()).toThrow('动态合成')
    const response = await request(s.server, `/api/projects/${s.projectId}/package`)
    expect(response.status).toBe(422)
    const body = await response.text()
    expect(body).not.toContain(secret.name)
    expect(body).not.toContain(secret.id)
    s.doc.destroy()
  })

  it('历史候选放成普通视频并删除原motion后，副本仍显式保护完整源并随检查点与项目包迁移', async () => {
    const s = await seed()
    const copied = createElement(s.doc, {
      kind: 'video',
      assetId: assetOf(s.newer),
      params: { compositionSource: sourceOf(s.newer) },
      x: 400,
      y: 400,
      w: 320,
      h: 180,
      name: '已铺开的包装视频',
    })
    deleteElements(s.doc, [s.nodeId])
    s.server.rooms.get(s.canvasId).flush()
    const sourceIds = compositionAssetIds(sourceOf(s.newer))
    const references = documentReferences(s.doc)
    for (const id of sourceIds) {
      expect(references).toContainEqual(
        expect.objectContaining({ assetId: id, nodeId: copied, explicit: true }),
      )
      expect(s.server.mediaIndex.sources('local', id, { limit: 50 }).items).toContainEqual(
        expect.objectContaining({ nodeId: copied, type: 'canvas' }),
      )
    }
    const checkpoint = s.save()
    const pins = s.server.db.$client
      .prepare('SELECT asset_id FROM checkpoint_assets WHERE checkpoint_id=?')
      .all(checkpoint.id) as Array<{ asset_id: string }>
    expect(pins.map((pin) => pin.asset_id).sort()).toEqual([assetOf(s.newer), ...sourceIds].sort())
    const bytes = await download(s.server, s.projectId)
    const manifest = manifestOf(bytes)
    expect(manifest.assets.map((asset) => asset.id)).toEqual(expect.arrayContaining(sourceIds))
    const target = (await bootServer()).server
    const imported = await importInto(target, bytes)
    const restored = createDoc(target.rooms.get(imported.canvasId!).doc, { schedule: () => {} })
    expect(restored.get(copied)?.params?.compositionSource).toEqual(sourceOf(s.newer))
    expect(restored.get(s.nodeId)).toBeUndefined()
    restored.destroy()
    const path = s.server.assets.originalPath(sourceIds[0]!)
    renameSync(path, `${path}.missing`)
    expect(() => s.save()).toThrow('动态合成')
    expect((await request(s.server, `/api/projects/${s.projectId}/package`)).status).toBe(422)
    s.doc.destroy()
  })

  it('普通媒体副本的损坏来源schema不能作为软引用被静默忽略', async () => {
    const s = await seed()
    createElement(s.doc, {
      kind: 'video',
      assetId: assetOf(s.newer),
      params: { compositionSource: { version: 999 } },
      x: 0,
      y: 0,
      w: 320,
      h: 180,
    })
    deleteElements(s.doc, [s.nodeId])
    expect(() => s.save()).toThrow('动态合成')
    const response = await request(s.server, `/api/projects/${s.projectId}/package`)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'corrupt' })
    s.doc.destroy()
  })

  it('候选裁剪释放被移除来源，保留采用候选完整来源且不会pin无关资产', async () => {
    const s = await seed()
    adoptResult(s.doc, s.nodeId, s.older.id)
    const unrelated = await s.asset('unrelated-unreferenced-source')
    const currentSource = sourceOf(s.newer)
    const batch: NodeResult[] = Array.from({ length: MAX_RESULTS }, (_, index) => ({
      ...s.newer,
      id: `res_pending_${index}`,
      runId: `run_pending_${index}`,
    }))
    addResults(s.doc, s.nodeId, batch, { adopt: false })
    expect(currentResult(s.doc.get(s.nodeId)!)?.id).toBe(s.older.id)
    expect(s.doc.get(s.nodeId)?.results?.map((result) => result.id)).not.toContain(s.newer.id)
    s.doc.ydoc.transact(() => s.doc.mutable(s.nodeId)!.set('results', [s.older]), s.doc.origin)
    s.server.rooms.get(s.canvasId).flush()
    const ids = new Set(documentReferences(s.doc).map((ref) => ref.assetId))
    for (const id of compositionAssetIds(currentSource)) {
      expect(ids.has(id)).toBe(false)
      expect(s.server.mediaIndex.sources('local', id, { limit: 50 }).items).toEqual([])
    }
    expect(ids.has(unrelated.id)).toBe(false)
    const checkpoint = s.save()
    const pins = s.server.db.$client
      .prepare('SELECT asset_id FROM checkpoint_assets WHERE checkpoint_id=?')
      .all(checkpoint.id) as Array<{ asset_id: string }>
    expect(pins.map((pin) => pin.asset_id).sort()).toEqual(
      [assetOf(s.older), ...compositionAssetIds(sourceOf(s.older))].sort(),
    )
    s.doc.destroy()
  })
})

import { renameSync } from 'node:fs'
import { Readable } from 'node:stream'
import {
  addResults,
  adoptResult,
  connect,
  createDoc,
  createElement,
  creativeReviewTarget,
  currentResult,
  getCreativeReview,
  recordCreativeReview,
  setParam,
} from '@plein/doc'
import type {
  Canvas,
  LibraryItem,
  ProjectImportPreview,
  ProjectImportResult,
  ProjectPackageManifest,
  ProjectPackageSummary,
} from '@plein/protocol'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import sharp from 'sharp'
import * as Y from 'yjs'
import { describe, expect, it, vi } from 'vite-plus/test'
import { hasFfmpeg } from '../assets/media'
import type { Server } from '../app'
import { jobs, projects } from '../storage/schema'
import {
  addNode,
  bootServer,
  createCanvas,
  mockSettings,
  request,
  tempDir,
  until,
  VIDEO_V1_PORTS,
} from '../testing'
import { remapDoc } from './package'
import { createCheckpointService } from '../checkpoints/service'
import { createMediaIndex } from '../media-index/service'

const SECRET = 'sk-plein-test-secret-0123456789'

async function call<T>(server: Server, path: string, init: RequestInit = {}) {
  const res = await request(server, path, init)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
}

async function png(color: string) {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: color } })
    .png()
    .toBuffer()
}

async function runNode(server: Server, canvasId: string, nodeId: string) {
  server.runs.start(canvasId, nodeId, 'local')
  await until(() => {
    const status = server.rooms.withDoc(canvasId, (d) => d.get(nodeId)?.run?.status)
    return status === 'succeeded' || status === 'failed'
  }, 30_000)
}

/** 一个项目：导入的图片、跑过两次的图片节点（两个候选）、从资产库放上来的角色卡 */
async function seed() {
  const a = await bootServer()
  const server = a.server
  mockSettings(server, {})
  // 平台密钥：项目包里不能出现
  server.plugins.configs.update('plein/minimax', { secrets: { apiKey: SECRET } })
  const { id: canvasId, doc } = await createCanvas(server)
  const { body: canvas } = await call<Canvas>(server, `/api/canvases/${canvasId}`)
  const photo = await server.assets.ingest('local', Readable.from([await png('#c00')]), {
    mime: 'image/png',
    name: '参考.png',
  })
  const face = await server.assets.ingest('local', Readable.from([await png('#0c0')]), {
    mime: 'image/png',
    name: '林夏.png',
  })
  const { body: item } = await call<LibraryItem>(server, '/api/library', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'character',
      name: '林夏',
      projectId: canvas.projectId,
      voice: { provider: 'plein/mock', voiceId: 'mock-female' },
      images: [{ slot: 'main', assetId: face.id }],
    }),
  })
  const imageEl = createElement(doc, { kind: 'image', assetId: photo.id, x: 0, y: 0, w: 16, h: 16 })
  const card = addNode(doc, 'plein/character', {
    name: '林夏',
    params: { libraryId: item.id },
    x: 300,
  })
  const gen = addNode(doc, 'plein/image', {
    params: { prompt: '天台', model: 'plein/mock:image' },
    x: 600,
  })
  connect(doc, [imageEl, 'image'], [gen, 'references'])
  await runNode(server, canvasId, gen)
  setParam(doc, gen, 'prompt', '天台，黄昏')
  await runNode(server, canvasId, gen)
  return { ...a, canvasId, projectId: canvas.projectId, doc, photo, face, item, card, gen, imageEl }
}

async function download(server: Server, projectId: string, history = false) {
  const res = await request(
    server,
    `/api/projects/${projectId}/package${history ? '?history=1' : ''}`,
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('content-disposition')).toMatch(/\.plein/)
  return Buffer.from(await res.arrayBuffer())
}

const upload = (server: Server, data: Uint8Array) =>
  call<ProjectImportPreview & { error?: string; message?: string }>(
    server,
    '/api/project-imports',
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: data,
    },
  )

async function importInto(server: Server, data: Uint8Array) {
  const preview = await upload(server, data)
  expect(preview.status).toBe(201)
  const done = await call<ProjectImportResult>(
    server,
    `/api/project-imports/${preview.body.token}`,
    {
      method: 'POST',
    },
  )
  expect(done.status).toBe(201)
  return { preview: preview.body, result: done.body }
}

const manifestOf = (data: Uint8Array) =>
  JSON.parse(strFromU8(unzipSync(data)['manifest.json']!)) as ProjectPackageManifest

const openDoc = (server: Server, canvasId: string) =>
  createDoc(server.rooms.get(canvasId).doc, { schedule: () => {} })

const checkpointService = (server: Server) =>
  createCheckpointService({
    db: server.db,
    rooms: server.rooms,
    assets: server.assets,
    index: createMediaIndex({ db: server.db, rooms: server.rooms }),
  })

describe('命名检查点项目包迁移', () => {
  it('当前候选项目包保留选中视频及其尾帧、关联键和各自验收，导入不串配对', async () => {
    const s = await seed()
    const video = addNode(s.doc, 'plein/video', {
      params: { model: 'plein/mock:video', mode: 'text', prompt: '两个水杯视频', count: 2 },
    })
    await runNode(s.server, s.canvasId, video)
    const videos = s.doc.get(video)!.results!
    expect(videos).toHaveLength(2)
    const tails = await Promise.all(
      ['#048', '#840'].map(async (color) =>
        s.server.assets.ingest('local', Readable.from([await png(color)]), {
          mime: 'image/png',
          name: '尾帧.png',
        }),
      ),
    )
    addResults(
      s.doc,
      video,
      videos.map((result, i) => ({
        id: `tail-${i}`,
        port: 'lastFrame',
        runId: result.runId,
        outputGroup: result.outputGroup,
        at: result.at,
        value: { type: 'image', assetId: tails[i]!.id },
      })),
      { adopt: false },
    )
    adoptResult(s.doc, video, 'tail-1')
    const mainTarget = creativeReviewTarget(s.doc.get(video))!
    const tailTarget = creativeReviewTarget(s.doc.get(video), 'lastFrame')!
    expect(
      recordCreativeReview(s.doc, video, {
        target: mainTarget,
        status: 'usable',
        note: '视频可用',
      }),
    ).toBe(true)
    expect(
      recordCreativeReview(s.doc, video, {
        target: tailTarget,
        status: 'changes',
        note: '尾帧待修改',
      }),
    ).toBe(true)
    const bytes = await download(s.server, s.projectId)
    const manifest = manifestOf(bytes)
    expect(manifest.assets.map((asset) => asset.id)).toContain(tails[1]!.id)
    expect(manifest.assets.map((asset) => asset.id)).not.toContain(tails[0]!.id)
    const target = await bootServer({ dataDir: tempDir() })
    const imported = await importInto(target.server, bytes)
    const restored = openDoc(target.server, imported.result.canvasId!).get(video)!
    expect(restored.results!.map((r) => r.id).sort()).toEqual([videos[1]!.id, 'tail-1'].sort())
    expect(restored.results!.every((r) => r.outputGroup === videos[1]!.outputGroup)).toBe(true)
    expect(currentResult(restored, 'video')?.id).toBe(videos[1]!.id)
    expect(currentResult(restored, 'lastFrame')?.id).toBe('tail-1')
    expect(getCreativeReview(restored)?.note).toBe('视频可用')
    expect(getCreativeReview(restored, tailTarget)?.note).toBe('尾帧待修改')
  })
  it.each([false, true])(
    '默认导出只保留真正采用的候选，不因同次运行或无采用而携带其他候选（待采用=%s）',
    async (held) => {
      const s = await seed()
      setParam(s.doc, s.gen, 'prompt', '同次两个不同水杯')
      setParam(s.doc, s.gen, 'count', 2)
      await runNode(s.server, s.canvasId, s.gen)
      const before = s.doc.get(s.gen)!
      expect(before.results).toHaveLength(4)
      if (held) s.doc.mutable(s.gen)!.set('adopted', null)
      const bytes = await download(s.server, s.projectId)
      const manifest = manifestOf(bytes)
      const snapshot = new Y.Doc()
      Y.applyUpdate(snapshot, unzipSync(bytes)[manifest.canvases[0]!.file.path]!)
      const packed = createDoc(snapshot)
      const result = packed.get(s.gen)!
      expect(result.results ?? []).toEqual(held ? [] : [before.results![0]])
      const assets = manifest.assets.map((a) => a.id)
      for (const candidate of before.results!) {
        if ('assetId' in candidate.value)
          expect(assets.includes(candidate.value.assetId)).toBe(
            !held && candidate.id === before.results![0]!.id,
          )
      }
      expect(s.doc.get(s.gen)!.results).toHaveLength(4)
      const target = await bootServer({ dataDir: tempDir() })
      const imported = await importInto(target.server, bytes)
      const restored = openDoc(target.server, imported.result.canvasId!)
      expect(restored.get(s.gen)?.results ?? []).toHaveLength(held ? 0 : 1)
      expect(currentResult(restored.get(s.gen)!)?.id).toBe(
        held ? undefined : before.results![0]!.id,
      )
      if (held) expect(restored.get(s.gen)?.adopted).toBeNull()
      const all = await download(s.server, s.projectId, true)
      const allManifest = manifestOf(all)
      const allState = new Y.Doc()
      Y.applyUpdate(allState, unzipSync(all)[allManifest.canvases[0]!.file.path]!)
      expect(createDoc(allState).get(s.gen)?.results).toHaveLength(4)
    },
  )
  it('v2默认完整保留检查点候选与独有素材，在新数据目录导入后可恢复且不续跑', async () => {
    const s = await seed()
    const service = checkpointService(s.server)
    const cp = service.create('local', s.canvasId, {
      name: '全部候选',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(s.doc.ydoc))).toString('base64'),
    })
    const saved = service.detail('local', cp.id)
    // 当前画布不再引用最旧候选；检查点仍必须带它迁移。
    const node = s.doc.get(s.gen)!
    const keep = node.results![0]!
    s.doc.mutable(s.gen)!.set('results', [keep])
    s.doc.mutable(s.gen)!.set('adopted', keep.id)
    const bytes = await download(s.server, s.projectId)
    const manifest = manifestOf(bytes)
    expect(manifest.formatVersion).toBe(2)
    expect(manifest.checkpoints).toHaveLength(1)
    const savedDoc = createDoc()
    Y.applyUpdate(savedDoc.ydoc, Buffer.from(saved.state, 'base64'))
    for (const result of savedDoc.get(s.gen)!.results!)
      if ('assetId' in result.value)
        expect(manifest.assets.map((a) => a.id)).toContain(result.value.assetId)
    const target = await bootServer({ dataDir: tempDir() })
    const imported = await importInto(target.server, bytes)
    expect(imported.preview.counts.checkpoints).toBe(1)
    const restoredService = checkpointService(target.server)
    const migrated = restoredService.list('local', imported.result.projectId, { limit: 50 })
      .items[0]!
    const restored = restoredService.restore('local', migrated.id)
    const doc = openDoc(target.server, restored.canvasId)
    expect(doc.get(s.gen)!.results).toHaveLength(2)
    expect(doc.get(s.gen)!.run).toBeUndefined()
    const rows = target.server.db.$client
      .prepare('SELECT calls,status FROM jobs WHERE canvas_id=?')
      .all(restored.canvasId) as Array<{ calls: string; status: string }>
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.calls === '{}' && r.status === 'succeeded')).toBe(true)
    expect(
      target.server.db.$client
        .prepare('SELECT * FROM checkpoint_assets WHERE checkpoint_id=?')
        .all(migrated.id).length,
    ).toBeGreaterThan(0)
    doc.destroy()
    savedDoc.destroy()
  })

  it('检查点文件坏哈希拒绝导入；检查点写入失败时项目、画布和pin整体回滚', async () => {
    const s = await seed(),
      service = checkpointService(s.server)
    service.create('local', s.canvasId, {
      name: '版本',
      expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(s.doc.ydoc))).toString('base64'),
    })
    const bytes = await download(s.server, s.projectId)
    const files = unzipSync(bytes),
      manifest = manifestOf(bytes)
    files[manifest.checkpoints[0]!.file.path] = strToU8('broken')
    const target = await bootServer({ dataDir: tempDir() })
    const broken = await upload(target.server, zipSync(files))
    expect(broken.status).toBe(422)
    expect(broken.body.error).toBe('hash_mismatch')
    const preview = await upload(target.server, bytes)
    expect(preview.status).toBe(201)
    target.server.db.$client.exec(
      "CREATE TRIGGER reject_checkpoint BEFORE INSERT ON canvas_checkpoints BEGIN SELECT RAISE(FAIL,'checkpoint test failure'); END",
    )
    const result = await request(target.server, `/api/project-imports/${preview.body.token}`, {
      method: 'POST',
    })
    expect(result.status).toBe(500)
    expect(target.server.db.$client.prepare('SELECT * FROM projects').all()).toHaveLength(0)
    expect(target.server.db.$client.prepare('SELECT * FROM canvases').all()).toHaveLength(0)
    expect(target.server.db.$client.prepare('SELECT * FROM canvas_checkpoints').all()).toHaveLength(
      0,
    )
    expect(target.server.db.$client.prepare('SELECT * FROM checkpoint_assets').all()).toHaveLength(
      0,
    )
  })
})

describe('项目包导出', () => {
  it('默认只带当前采用的候选；清单列出素材、资产库条目、哈希和依赖；不含密钥和本机路径', async () => {
    const s = await seed()
    const { body: summary } = await call<ProjectPackageSummary>(
      s.server,
      `/api/projects/${s.projectId}/package/summary`,
    )
    expect(summary).toMatchObject({ candidates: 'current', canvases: 1, library: 1, jobs: 2 })
    expect(summary.tooLarge).toBe(false)

    const data = await download(s.server, s.projectId)
    const files = unzipSync(data)
    const m = manifestOf(data)
    expect(m).toMatchObject({ format: 'plein-project', formatVersion: 1, candidates: 'current' })
    const current = s.doc.get(s.gen)!.results![0]!.value as { assetId: string }
    const older = s.doc.get(s.gen)!.results![1]!.value as { assetId: string }
    const ids = m.assets.map((a) => a.id)
    expect(ids).toEqual(expect.arrayContaining([s.photo.id, s.face.id, current.assetId]))
    expect(ids).not.toContain(older.assetId)
    for (const a of m.assets) expect(files[a.file.path]?.byteLength).toBe(a.size)
    expect(m.library.map((l) => l.id)).toEqual([s.item.id])
    expect(m.dependencies.models).toEqual(['plein/mock:image'])
    expect(m.dependencies.voices).toEqual([{ provider: 'plein/mock', voiceId: 'mock-female' }])
    expect(m.dependencies.nodes.map((n) => n.type).sort()).toEqual([
      'plein/character',
      'plein/image',
    ])
    expect(m.missing).toEqual([])

    const raw = Buffer.from(data).toString('latin1')
    for (const f of Object.values(files)) {
      const text = Buffer.from(f).toString('utf8')
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(s.dataDir)
    }
    expect(raw).not.toContain(SECRET)
    expect(raw).not.toContain(s.dataDir)

    const all = manifestOf(await download(s.server, s.projectId, true))
    expect(all.candidates).toBe('all')
    expect(all.assets.map((a) => a.id)).toContain(older.assetId)
  })

  it('文档里引用的素材找不到时记为缺失，运行中的任务导出为历史', async () => {
    const s = await seed()
    createElement(s.doc, { kind: 'image', assetId: 'f'.repeat(64), x: 0, y: 300, w: 10, h: 10 })
    s.server.db
      .update(jobs)
      .set({ status: 'running', error: `失败于 ${s.dataDir}/tmp/x` })
      .run()
    const m = manifestOf(await download(s.server, s.projectId))
    expect(m.missing).toEqual([expect.objectContaining({ kind: 'asset', id: 'f'.repeat(64) })])
    const history = JSON.parse(
      strFromU8(unzipSync(await download(s.server, s.projectId))['history/jobs.json']!),
    ) as Array<{ status: string; error: string }>
    expect(history.every((j) => j.status === 'canceled')).toBe(true)
    expect(JSON.stringify(history)).not.toContain(s.dataDir)
  })
})

describe('项目包导入', () => {
  it('旧角色图片槽位在导出与导入时兼容规范化，重复用途和未知槽位仍完整往返', async () => {
    const s = await seed()
    const legacyImages = [
      { slot: 'main', assetId: s.face.id },
      { slot: 'half', assetId: s.face.id },
      { slot: 'portrait', assetId: s.photo.id },
      { slot: 'head_3view', assetId: s.photo.id },
    ]
    const canonicalImages = [
      { slot: 'full_body', assetId: s.face.id },
      { slot: 'portrait', assetId: s.face.id },
      { slot: 'extra', assetId: s.photo.id },
      { slot: 'head_3view', assetId: s.photo.id },
    ]
    s.server.db.$client
      .prepare('UPDATE library_items SET data=? WHERE id=?')
      .run(JSON.stringify({ images: legacyImages }), s.item.id)
    const data = await download(s.server, s.projectId)
    const manifest = manifestOf(data)
    expect(manifest.library[0]?.images).toEqual(canonicalImages)
    expect(manifest.assets.map((asset) => asset.id)).toEqual(
      expect.arrayContaining([s.face.id, s.photo.id]),
    )

    // 模拟旧版本项目包，直接经过导入事务写入时也要规范化。
    const files = unzipSync(data)
    manifest.library[0]!.images = legacyImages
    files['manifest.json'] = strToU8(JSON.stringify(manifest))
    const target = await bootServer({ dataDir: tempDir() })
    await importInto(target.server, zipSync(files))
    expect(target.server.library.get('local', s.item.id)?.images).toEqual(canonicalImages)
    const row = target.server.db.$client
      .prepare('SELECT data FROM library_items WHERE id=?')
      .get(s.item.id) as { data: string }
    expect(JSON.parse(row.data).images).toEqual(canonicalImages)
  })

  it('迁入另一个数据目录：画布、素材、资产库与运行记录齐全，原目录不可访问也能打开', async () => {
    const s = await seed()
    const files = unzipSync(await download(s.server, s.projectId))
    const legacy = JSON.parse(strFromU8(files['manifest.json']!)) as Record<string, unknown>
    expect(legacy.formatVersion).toBe(1)
    delete legacy.checkpoints
    files['manifest.json'] = strToU8(JSON.stringify(legacy))
    const data = zipSync(files)
    await s.close()
    renameSync(s.dataDir, `${s.dataDir}-gone`)

    const { server } = await bootServer({ dataDir: tempDir() })
    const { preview, result } = await importInto(server, data)
    expect(preview.counts.checkpoints).toBe(0)
    expect(preview).toMatchObject({
      copy: false,
      counts: { canvases: 1, library: 1, jobs: 2 },
      remapped: { canvases: 0, library: 0, jobs: 0 },
      models: [{ ref: 'plein/mock:image', status: 'ok' }],
      voices: [{ provider: 'plein/mock', voiceId: 'mock-female', status: 'unverified' }],
    })
    expect(preview.nodes.every((n) => n.status === 'ok')).toBe(true)
    // 没有冲突时保留原 id
    expect(result.projectId).toBe(s.projectId)
    expect(result.canvasId).toBe(s.canvasId)

    const doc = openDoc(server, result.canvasId!)
    expect(doc.get(s.gen)!.results).toHaveLength(1)
    expect(doc.get(s.card)!.params?.libraryId).toBe(s.item.id)
    for (const id of [s.photo.id, s.face.id]) {
      const res = await request(server, `/api/assets/${id}`)
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
    }
    expect(server.assets.get('local', s.photo.id)?.variants).toContain('thumb-256')
    const { body: lib } = await call<LibraryItem[]>(server, '/api/library')
    expect(lib).toEqual([expect.objectContaining({ id: s.item.id, projectId: s.projectId })])
    const { body: list } = await call<{ jobs: Array<{ id: string }> }>(
      server,
      `/api/canvases/${result.canvasId}/jobs`,
    )
    expect(list.jobs).toHaveLength(2)
  })

  it('同一个包再导入一次：作为副本导入，所有 id 换新，文档里的引用一起改', async () => {
    const s = await seed()
    const data = await download(s.server, s.projectId)
    // 直接导回原目录：项目、画布、条目、任务全都冲突
    const { preview, result } = await importInto(s.server, data)
    expect(preview.copy).toBe(true)
    expect(preview.remapped).toEqual({ canvases: 1, library: 1, jobs: 2 })
    expect(result.projectId).not.toBe(s.projectId)
    expect(result.title).toMatch(/（副本）$/)
    expect(result.canvasId).not.toBe(s.canvasId)

    const doc = openDoc(s.server, result.canvasId!)
    const libraryId = doc.get(s.card)!.params?.libraryId as string
    expect(libraryId).not.toBe(s.item.id)
    const { body: copy } = await call<LibraryItem>(s.server, `/api/library/${libraryId}`)
    expect(copy).toMatchObject({ name: '林夏', projectId: result.projectId })
    const node = doc.get(s.gen)!
    const { body: list } = await call<{ jobs: Array<{ id: string }> }>(
      s.server,
      `/api/canvases/${result.canvasId}/jobs`,
    )
    const jobIds = list.jobs.map((j) => j.id)
    expect(jobIds).toContain(node.run!.id)
    expect(jobIds).toContain(node.results![0]!.runId)
    expect(jobIds).not.toContain(s.doc.get(s.gen)!.run!.id)
    // 原项目不受影响
    expect(s.doc.get(s.card)!.params?.libraryId).toBe(s.item.id)
  })

  it('全局资产库条目：本机同一所有者已有的直接复用，副本里的引用不改', async () => {
    const s = await seed()
    const { body: shared } = await call<LibraryItem>(s.server, '/api/library', {
      method: 'POST',
      body: JSON.stringify({ kind: 'prop', name: '铁盒', images: [] }),
    })
    const prop = addNode(s.doc, 'plein/prop', { name: '铁盒', params: { libraryId: shared.id } })
    const data = await download(s.server, s.projectId)
    expect(manifestOf(data).library.map((l) => l.id)).toContain(shared.id)
    const before = (await call<LibraryItem[]>(s.server, '/api/library')).body.length
    const { preview, result } = await importInto(s.server, data)
    expect(preview.copy).toBe(true)
    expect(preview.reusedLibrary).toBe(1)
    // 项目自己的条目仍换新复制一份，全局条目不重复添加
    expect(preview.remapped.library).toBe(1)
    expect((await call<LibraryItem[]>(s.server, '/api/library')).body.length).toBe(before + 1)
    const doc = openDoc(s.server, result.canvasId!)
    expect(doc.get(prop)!.params?.libraryId).toBe(shared.id)
  })

  it('运行中状态迁入后是历史记录，不会被当作待续跑的任务', () => {
    const ydoc = createDoc(undefined, { schedule: () => {} })
    const n = addNode(ydoc, 'plein/image', { params: { libraryId: 'lib_a', nested: ['lib_a'] } })
    ydoc.ydoc.transact(() => {
      ydoc.mutable(n)!.set('run', { id: 'run_a', status: 'running', progress: 0.5, at: 1 })
    })
    setParam(ydoc, n, 'other', 'keep')
    const out = remapDoc(
      Y.encodeStateAsUpdate(ydoc.ydoc),
      new Map([
        ['lib_a', 'lib_b'],
        ['run_a', 'run_b'],
      ]),
    )
    const back = createDoc(undefined, { schedule: () => {} })
    Y.applyUpdate(back.ydoc, out)
    const el = back.get(n)!
    expect(el.params).toMatchObject({ libraryId: 'lib_b', nested: ['lib_b'], other: 'keep' })
    expect(el.run).toMatchObject({ id: 'run_b', status: 'canceled' })
    expect(el.run?.progress).toBeUndefined()
  })

  it('写入失败时整个回滚，不留下半个项目', async () => {
    const s = await seed()
    const data = await download(s.server, s.projectId)
    const { server } = await bootServer({ dataDir: tempDir() })
    const preview = await upload(server, data)
    vi.spyOn(server.assets, 'insert').mockImplementationOnce(() => {
      throw new Error('磁盘满了')
    })
    const res = await request(server, `/api/project-imports/${preview.body.token}`, {
      method: 'POST',
    })
    expect(res.status).toBe(500)
    expect(server.db.select().from(projects).all()).toEqual([])
    expect(server.db.select().from(jobs).all()).toEqual([])
    // 令牌用过就失效，需要重新选择文件
    const again = await request(server, `/api/project-imports/${preview.body.token}`, {
      method: 'POST',
    })
    expect(again.status).toBe(404)
  })
})

describe('项目包校验', () => {
  async function pkg() {
    const s = await seed()
    const data = await download(s.server, s.projectId)
    const { server } = await bootServer({ dataDir: tempDir() })
    return { server, files: unzipSync(data), manifest: manifestOf(data) }
  }

  const rezip = (files: Record<string, Uint8Array>) => zipSync(files, { level: 0 })

  it('不是 zip、没有清单：说明需要选择 .plein 文件', async () => {
    const { server, files } = await pkg()
    const notZip = await upload(server, strToU8('hello'))
    expect(notZip.status).toBe(422)
    expect(notZip.body).toMatchObject({ error: 'not_a_package' })
    expect(notZip.body.message).toMatch(/\.plein/)
    const { 'manifest.json': _, ...rest } = files
    const noManifest = await upload(server, rezip(rest))
    expect(noManifest.body).toMatchObject({ error: 'not_a_package' })
  })

  it('格式版本更高：提示升级', async () => {
    const { server, files, manifest } = await pkg()
    const res = await upload(
      server,
      rezip({
        ...files,
        'manifest.json': strToU8(JSON.stringify({ ...manifest, formatVersion: 99 })),
      }),
    )
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: 'unsupported_version' })
    expect(res.body.message).toMatch(/升级/)
  })

  it('缺文件、内容被改：拒绝并提示重新导出', async () => {
    const { server, files, manifest } = await pkg()
    const asset = manifest.assets[0]!.file.path
    const { [asset]: _, ...rest } = files
    const missing = await upload(server, rezip(rest))
    expect(missing.body).toMatchObject({ error: 'missing_file' })
    expect(missing.body.message).toContain(asset)
    expect(missing.body.message).toMatch(/重新导出/)

    const tampered = new Uint8Array(files[asset]!)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    const bad = await upload(server, rezip({ ...files, [asset]: tampered }))
    expect(bad.body).toMatchObject({ error: 'hash_mismatch' })
    expect(bad.body.message).toContain(asset)

    const truncated = Buffer.from(rezip(files)).subarray(0, 200)
    const cut = await upload(server, truncated)
    expect(cut.status).toBe(422)
    // 截断的包不能说成「不是项目包」，要说明文件不完整
    expect(cut.body).toMatchObject({ error: 'corrupt' })
    expect(cut.body.message).toMatch(/不完整/)
    expect(server.db.select().from(projects).all()).toEqual([])
  })

  it('清单超过大小上限：说明是清单的问题，不说成哈希不符', async () => {
    const { server } = await bootServer()
    // 大小校验先于 JSON / 项目内容校验；直接构造真实上限 + 1 字节，省去素材生成与大字符串编码。
    const padded = new Uint8Array(64 * 1024 * 1024 + 1).fill(0x20)
    padded[0] = 0x7b
    padded[padded.length - 1] = 0x7d
    const res = await upload(server, zipSync({ 'manifest.json': [padded, { level: 1 }] }))
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: 'corrupt' })
    expect(res.body.message).toMatch(/manifest\.json 超过 64 MB/)
    // 保留真实 64 MiB 解压与哈希路径，为并发 CI 的大载荷测试留出余量。
  }, 15_000)

  it('越出包目录的路径：拒绝导入', async () => {
    const { server, files, manifest } = await pkg()
    const escaping = await upload(server, rezip({ ...files, '../evil.txt': strToU8('x') }))
    expect(escaping.body).toMatchObject({ error: 'unsafe_path' })

    const path = manifest.canvases[0]!.file.path
    const moved = {
      ...manifest,
      canvases: [
        {
          ...manifest.canvases[0]!,
          file: { ...manifest.canvases[0]!.file, path: 'canvases/../../x.yjs' },
        },
      ],
    }
    const res = await upload(
      server,
      rezip({ ...files, 'manifest.json': strToU8(JSON.stringify(moved)), [path]: files[path]! }),
    )
    expect(res.body).toMatchObject({ error: 'unsafe_path' })
  })
})

const ffmpeg = await hasFfmpeg()

describe.skipIf(!ffmpeg)('项目包迁移后导出成片', () => {
  it('迁入新目录后，用迁入的镜头视频在本机 ffmpeg 合成序列', async () => {
    const a = await bootServer()
    mockSettings(a.server, {})
    const { id: canvasId, doc } = await createCanvas(a.server)
    const { body: canvas } = await call<Canvas>(a.server, `/api/canvases/${canvasId}`)
    const v1 = addNode(doc, 'plein/video', { params: { prompt: '推近' }, ports: VIDEO_V1_PORTS })
    const v2 = addNode(doc, 'plein/video', {
      params: { prompt: '拉远' },
      ports: VIDEO_V1_PORTS,
      x: 300,
    })
    const seq = addNode(doc, 'plein/sequence', {
      params: { resolution: '720p', subtitles: false },
      x: 600,
    })
    connect(doc, [v1, 'video'], [seq, 'clips'])
    connect(doc, [v2, 'video'], [seq, 'clips'])
    const line = addNode(doc, 'plein/speech', { params: { text: '你来了' }, y: 300 })
    connect(doc, [line, 'audio'], [seq, 'dialogue'])
    await runNode(a.server, canvasId, line)
    await runNode(a.server, canvasId, v1)
    await runNode(a.server, canvasId, v2)
    const data = await download(a.server, canvas.projectId)
    await a.close()
    renameSync(a.dataDir, `${a.dataDir}-gone`)

    const { server } = await bootServer({ dataDir: tempDir() })
    mockSettings(server, {})
    const { result } = await importInto(server, data)
    await runNode(server, result.canvasId!, seq)
    const node = openDoc(server, result.canvasId!).get(seq)!
    expect(node.run?.error).toBeUndefined()
    expect(node.run?.status).toBe('succeeded')
    const out = server.assets.get('local', (node.results![0]!.value as { assetId: string }).assetId)
    expect(out).toMatchObject({ kind: 'video', width: 720, height: 1280 })
    expect(out!.duration).toBeGreaterThan(0)
  }, 60_000)
})

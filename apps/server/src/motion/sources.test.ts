import { renameSync } from 'node:fs'
import { Readable } from 'node:stream'
import { addResults, createDoc, createElement, deleteElements, type PleinDoc } from '@plein/doc'
import { MOTION_TEMPLATE_VERSION, MotionParams } from '@plein/nodes'
import type { CompositionSourceRef } from '@plein/plugin-sdk'
import * as Y from 'yjs'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import type { Server } from '../app'
import { insertCanvas, insertProject } from '../storage/canvases'
import { addNode, bootServer, request, until } from '../testing'
import { HYPERFRAMES_VERSION } from './runtime'
import { motionAssetSources, type MotionAssetSource } from './sources'

async function setup() {
  const { server } = await bootServer()
  await until(() => server.mediaIndex.ready)
  const asset = (owner: string, bytes: string, mime = 'application/octet-stream') =>
    server.assets.ingest(owner, Readable.from([bytes]), { mime, name: bytes.slice(0, 40) })
  const video = await asset('local', 'shared-rendered-video')
  async function source(title: string, owner = 'local'): Promise<CompositionSourceRef> {
    const [bundle, dependency, manifest] = await Promise.all([
      asset(owner, `source-bundle:${title}`),
      asset(owner, `source-dependency:${title}`),
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
      rendererIdentity: 'test/hyperframes-sources',
    }
  }
  return { server, video, source, asset }
}

function canvas(server: Server, owner = 'local') {
  const project = insertProject(server.db, owner, '来源查询回归')
  const id = insertCanvas(server.db, owner, project, '来源查询回归')
  const doc = createDoc(server.rooms.get(id).doc, { schedule: () => {} })
  onTestFinished(() => doc.destroy())
  return { id, doc }
}

function copy(doc: PleinDoc, assetId: string, source?: unknown) {
  return createElement(doc, {
    kind: 'video',
    assetId,
    ...(source === undefined ? {} : { params: { compositionSource: source } }),
    x: 0,
    y: 0,
    w: 320,
    h: 180,
  })
}

function candidate(doc: PleinDoc, node: string, assetId: string, source: CompositionSourceRef) {
  addResults(
    doc,
    node,
    [
      {
        id: `res_${source.manifestAssetId}`,
        runId: `run_${source.manifestAssetId}`,
        port: 'video',
        at: Date.now(),
        value: { type: 'video', assetId, compositionSource: source },
      },
    ],
    { adopt: false },
  )
}

function checkpoint(server: Server, id: string, doc: PleinDoc, owner = 'local') {
  return server.checkpoints.create(owner, id, {
    name: '来源保留',
    expectedSnapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc.ydoc))).toString('base64'),
  })
}

async function sources(server: Server, id: string) {
  const response = await request(server, `/api/motion/asset/${id}/sources`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { sources: MotionAssetSource[] }).sources
}

const manifests = (items: MotionAssetSource[]) =>
  items.map((item) => item.compositionSource.manifestAssetId).sort()

// 只验证来源的查询、校验与保留边界；fixture 不执行媒体解码或渲染。
describe('动态合成素材来源查询', () => {
  it('同一产物按 manifest 列出多个源版本；候选和普通副本的同版引用只出现一次', async () => {
    const s = await setup()
    const { doc } = canvas(s.server)
    const [first, second] = await Promise.all([s.source('标题甲'), s.source('标题乙')])
    const node = addNode(doc, 'plein/motion')
    candidate(doc, node, s.video.id, first)
    candidate(doc, node, s.video.id, second)
    copy(doc, s.video.id, first)
    const found = await sources(s.server, s.video.id)
    expect(manifests(found)).toEqual([first.manifestAssetId, second.manifestAssetId].sort())
    expect(found.map((item) => item.title).sort()).toEqual(['标题乙', '标题甲'])
  })

  it('删除原 motion 后普通媒体副本仍能提供完整来源', async () => {
    const s = await setup()
    const { doc } = canvas(s.server)
    const source = await s.source('普通媒体副本来源')
    const node = addNode(doc, 'plein/motion')
    candidate(doc, node, s.video.id, source)
    copy(doc, s.video.id, source)
    deleteElements(doc, [node])
    expect(await sources(s.server, s.video.id)).toEqual([
      { compositionSource: source, title: '普通媒体副本来源' },
    ])
  })

  it('原画布删除后，精确固定该产物的命名检查点仍提供全部来源版本', async () => {
    const s = await setup()
    const { id, doc } = canvas(s.server)
    const [first, second] = await Promise.all([s.source('检查点甲'), s.source('检查点乙')])
    const node = addNode(doc, 'plein/motion')
    candidate(doc, node, s.video.id, first)
    candidate(doc, node, s.video.id, second)
    const saved = checkpoint(s.server, id, doc)
    expect((await request(s.server, `/api/canvases/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(
      s.server.db.$client
        .prepare('SELECT source_canvas_id FROM canvas_checkpoints WHERE id=?')
        .get(saved.id),
    ).toEqual({ source_canvas_id: null })
    expect(manifests(await sources(s.server, s.video.id))).toEqual(
      [first.manifestAssetId, second.manifestAssetId].sort(),
    )
  })

  it.each(['普通副本', '结果候选'] as const)(
    '声明损坏来源的%s明确返回错误，不退化为空列表',
    async (kind) => {
      const s = await setup()
      const { doc } = canvas(s.server)
      const broken = { version: 999 } as unknown as CompositionSourceRef
      if (kind === '普通副本') copy(doc, s.video.id, broken)
      else {
        // 构造已入库的损坏 Yjs 结果，模拟旧客户端或同步写入的非法来源字段。
        const node = addNode(doc, 'plein/motion')
        doc.mutable(node)!.set('results', [
          {
            id: 'res_broken',
            runId: 'run_broken',
            port: 'video',
            at: Date.now(),
            value: { type: 'video', assetId: s.video.id, compositionSource: broken },
          },
        ])
      }
      const response = await request(s.server, `/api/motion/asset/${s.video.id}/sources`)
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: 'invalid_source',
        message: '动态合成来源或依赖缺失，无法保留可编辑版本',
      })
    },
  )

  it('旧媒体未声明来源时仍返回空列表', async () => {
    const s = await setup()
    const { doc } = canvas(s.server)
    copy(doc, s.video.id)
    expect(await sources(s.server, s.video.id)).toEqual([])
  })

  it('相同产物在其他 owner 的活跃画布和检查点中出现也不泄露其来源', async () => {
    const s = await setup()
    const own = canvas(s.server)
    const foreign = canvas(s.server, 'other-owner')
    await s.asset('other-owner', 'shared-rendered-video')
    const [ownSource, otherSource] = await Promise.all([
      s.source('本用户版本'),
      s.source('其他用户的私密版本', 'other-owner'),
    ])
    copy(own.doc, s.video.id, ownSource)
    copy(foreign.doc, s.video.id, otherSource)
    checkpoint(s.server, foreign.id, foreign.doc, 'other-owner')
    expect(await sources(s.server, s.video.id)).toEqual([
      { compositionSource: ownSource, title: '本用户版本' },
    ])
    // 去掉另一个 owner 的活跃文档，只留下检查点路径。
    s.server.db.$client.prepare('DELETE FROM canvases WHERE id=?').run(foreign.id)
    s.server.rooms.drop(foreign.id)
    expect(await sources(s.server, s.video.id)).toEqual([
      { compositionSource: ownSource, title: '本用户版本' },
    ])
    expect(await motionAssetSources(s.server, 'other-owner', s.video.id)).toEqual([
      { compositionSource: otherSource, title: '其他用户的私密版本' },
    ])
  })

  it('产物只属于其他 owner 时查询返回 404', async () => {
    const s = await setup()
    const foreignVideo = await s.asset('other-owner', 'foreign-only-video')
    const response = await request(s.server, `/api/motion/asset/${foreignVideo.id}/sources`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found', message: '素材不存在' })
  })

  it('引用其他 owner 的源资产明确失败，响应不含私密标题或资产身份', async () => {
    const s = await setup()
    const { doc } = canvas(s.server)
    const foreign = await s.source('其他用户的私密版本', 'other-owner')
    copy(doc, s.video.id, foreign)
    const response = await request(s.server, `/api/motion/asset/${s.video.id}/sources`)
    expect(response.status).toBe(422)
    const body = await response.text()
    expect(body).not.toContain('其他用户的私密版本')
    expect(body).not.toContain(foreign.manifestAssetId)
    expect(body).not.toContain(foreign.bundleAssetId)
  })

  it.each(['bundleAssetId', 'manifestAssetId', 'dependencyAssetIds'] as const)(
    '%s 声明存在但物理原件缺失时明确失败',
    async (key) => {
      const s = await setup()
      const { doc } = canvas(s.server)
      const source = await s.source('缺失源依赖')
      copy(doc, s.video.id, source)
      const id = key === 'dependencyAssetIds' ? source[key][0]! : source[key]
      const path = s.server.assets.originalPath(id)
      renameSync(path, `${path}.missing`)
      const response = await request(s.server, `/api/motion/asset/${s.video.id}/sources`)
      expect(response.status).toBe(422)
      expect(await response.json()).toHaveProperty('error', 'invalid_source')
    },
  )

  it('超过 100 个源版本明确失败，不返回静默截断的选择列表', async () => {
    const s = await setup()
    const { doc } = canvas(s.server)
    for (let i = 0; i < 101; i++) copy(doc, s.video.id, await s.source(`版本 ${i}`))
    await expect(motionAssetSources(s.server, 'local', s.video.id)).rejects.toThrow('源版本过多')
    const response = await request(s.server, `/api/motion/asset/${s.video.id}/sources`)
    expect(response.status).toBe(422)
    expect(await response.json()).toHaveProperty('error', 'invalid_source')
  })
})

import { existsSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { referenceAssets } from '@plein/capabilities'
import {
  addResults,
  connect,
  createDoc,
  createElement,
  inputEdges,
  setParams,
  type PleinDoc,
} from '@plein/doc'
import {
  CreateLibraryItem,
  LibraryProfile,
  type ApplyLibraryUpdates,
  type LibraryUpdates,
} from '@plein/protocol'
import { Hono } from 'hono'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vite-plus/test'
import { findMentions, profileOf } from '@plein/nodes'
import type { AuthEnv } from '../auth'
import { insertCanvas, insertProject } from '../storage/canvases'
import { addNode, bootServer, mockModel, mockSettings } from '../testing'
import { libraryRevision, librarySyncRoutes } from './sync'

async function fixture() {
  const { server } = await bootServer()
  const makeImage = async (background: string, owner = 'local') =>
    server.assets.ingest(
      owner,
      Readable.from([
        await sharp({ create: { width: 8, height: 8, channels: 3, background } })
          .png()
          .toBuffer(),
      ]),
      { name: `${background}.png`, mime: 'image/png' },
    )
  const old = await makeImage('red')
  const newer = await makeImage('blue')
  const item = server.library.create(
    'local',
    CreateLibraryItem.parse({
      kind: 'character',
      name: '旧角色',
      description: '旧设定',
      voice: { provider: 'old/provider', voiceId: 'old-voice' },
      images: [{ slot: 'main', assetId: old.id }],
    }),
  )
  const project = insertProject(server.db, 'local', '同步测试')
  const docs: PleinDoc[] = []
  const place = (owner = 'local', name = '镜头画布') => {
    const projectId = owner === 'local' ? project : insertProject(server.db, owner, '其他所有者')
    const canvasId = insertCanvas(server.db, owner, projectId, name)
    const doc = createDoc(server.rooms.get(canvasId).doc, { schedule: (flush) => flush() })
    docs.push(doc)
    const card = addNode(doc, 'plein/character', {
      name: item.name,
      params: {
        libraryId: item.id,
        libraryRevision: libraryRevision(item),
        description: item.description,
        voice: item.voice,
      },
    })
    const ref = createElement(doc, {
      kind: 'image',
      assetId: old.id,
      x: -300,
      y: 0,
      w: 100,
      h: 100,
    })
    connect(doc, [ref, 'image'], [card, 'references'])
    return { canvasId, doc, card, ref }
  }
  const a = place('local', '画布 A')
  const b = place('local', '画布 B')
  const foreign = place('other')
  const deps = {
    db: server.db,
    rooms: server.rooms,
    assets: server.assets,
    library: server.library,
  }
  const app = (id = 'local', role: 'owner' | 'viewer' = 'owner') =>
    new Hono<AuthEnv>()
      .use('*', (c, next) => {
        c.set('principal', { id, role })
        return next()
      })
      .route('/', librarySyncRoutes(deps))
  const path = `/api/library/${item.id}/updates`
  const read = async () => {
    const response = await app().request(path)
    expect(response.status).toBe(200)
    return (await response.json()) as LibraryUpdates
  }
  const apply = (body: ApplyLibraryUpdates, actor = app()) =>
    actor.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const updated = () =>
    server.library.update('local', item.id, {
      name: '新角色',
      description: '新设定',
      voice: { provider: 'new/provider', voiceId: 'new-voice' },
      images: [{ slot: 'main', assetId: newer.id }],
    })!
  return {
    server,
    old,
    newer,
    item,
    a,
    b,
    foreign,
    app,
    path,
    read,
    apply,
    updated,
    docs,
    makeImage,
  }
}

describe('跨画布资产库版本同步', () => {
  it('已固定卡片不能直接update，必须先解除固定再明确同步', async () => {
    const s = await fixture()
    s.updated()
    const first = await s.read()
    const target = first.cards.find((c) => c.nodeId === s.a.card)!
    expect(
      (await s.apply({ revision: first.revision, targets: [{ ...target, mode: 'keep' }] })).status,
    ).toBe(200)
    const pinnedReport = await s.read()
    const pinned = pinnedReport.cards.find((c) => c.nodeId === s.a.card)!
    expect(
      (
        await s.apply({
          revision: pinnedReport.revision,
          targets: [{ ...pinned, mode: 'update', fields: ['description'] }],
        })
      ).status,
    ).toBe(409)
    expect(s.a.doc.get(s.a.card)!.params).toMatchObject({
      libraryPinned: true,
      description: '旧设定',
    })
    expect(
      (await s.apply({ revision: pinnedReport.revision, targets: [{ ...pinned, mode: 'unpin' }] }))
        .status,
    ).toBe(200)
    const fresh = await s.read()
    const ready = fresh.cards.find((c) => c.nodeId === s.a.card)!
    expect(
      (
        await s.apply({
          revision: fresh.revision,
          targets: [{ ...ready, mode: 'update', fields: ['description'] }],
        })
      ).status,
    ).toBe(200)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('新设定')
  })

  it('写库失败返回202和pending画布，已应用内容保持可见并可重新落盘', async () => {
    const s = await fixture()
    s.updated()
    const report = await s.read()
    const target = report.cards.find((c) => c.nodeId === s.a.card)!
    const room = s.server.rooms.get(s.a.canvasId)
    const flush = vi.spyOn(room, 'flush').mockImplementation(() => {
      throw new Error('模拟磁盘繁忙')
    })
    try {
      const response = await s.apply({
        revision: report.revision,
        targets: [{ ...target, mode: 'update', fields: ['description'] }],
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({
        updated: 1,
        persistence: 'pending',
        pendingCanvases: [s.a.canvasId],
      })
      expect(s.a.doc.get(s.a.card)!.params!.description).toBe('新设定')
    } finally {
      flush.mockRestore()
    }
    expect(() => room.flush()).not.toThrow()
  })

  it('批准名称同步保持已消歧引用和档案后缀，未绑定的同名引用不猜测', async () => {
    const s = await fixture()
    const duplicate = addNode(s.a.doc, 'plein/character', { name: s.item.name })
    const [first, chosen] = [s.a.card, duplicate].sort()
    if (chosen !== s.a.card) {
      setParams(s.a.doc, s.a.card, { libraryId: null })
      setParams(s.a.doc, chosen!, {
        libraryId: s.item.id,
        libraryRevision: libraryRevision(s.item),
        description: s.item.description,
      })
    }
    setParams(s.a.doc, chosen!, {
      profile: LibraryProfile.parse({ periods: [{ id: 'teen', name: '少年' }] }),
    })
    const otherNew = addNode(s.a.doc, 'plein/character', { name: '新角色' })
    const prompt = '@旧角色#2/少年 出镜，@旧角色 不猜；@旧角色#1 是另一个人'
    const generator = addNode(s.a.doc, 'plein/image', { params: { prompt } })
    s.updated()
    const report = await s.read()
    const target = report.cards.find((c) => c.nodeId === chosen)!
    expect(
      (
        await s.apply({
          revision: report.revision,
          targets: [{ ...target, mode: 'update', fields: ['description'] }],
        })
      ).status,
    ).toBe(200)
    expect(s.a.doc.get(generator)!.params!.prompt).toBe(prompt)
    const second = await s.read()
    const updatedTarget = second.cards.find((c) => c.nodeId === chosen)!
    expect(
      (
        await s.apply({
          revision: second.revision,
          targets: [{ ...updatedTarget, mode: 'update', fields: ['name'] }],
        })
      ).status,
    ).toBe(200)
    const ordinal = [chosen!, otherNew].sort().indexOf(chosen!) + 1
    const nextPrompt = String(s.a.doc.get(generator)!.params!.prompt)
    expect(nextPrompt).toBe(`@新角色#${ordinal}/少年 出镜，@旧角色 不猜；@旧角色#1 是另一个人`)
    const mentions = findMentions(
      nextPrompt,
      [first!, chosen!, otherNew].map((id) => {
        const el = s.a.doc.get(id)!
        return { id, name: el.name!, profile: profileOf(el.params?.profile) }
      }),
    )
    expect(mentions[0]).toMatchObject({ id: chosen, pick: { period: { id: 'teen' } } })
  })

  it.each(
    (['references', 'period', 'outfit', 'expression'] as const).flatMap((field) =>
      (['missing', 'foreign', 'wrong-kind', 'missing-file'] as const).map(
        (failure) => [field, failure] as const,
      ),
    ),
  )('%s 图片出现 %s 时阻断，未选择图片字段仍可同步文字', async (field, failure) => {
    const s = await fixture()
    let badId = 'f'.repeat(64)
    if (failure === 'foreign') badId = (await s.makeImage('green', 'other')).id
    if (failure === 'wrong-kind') {
      mockSettings(s.server, {})
      const audio = await s.server.plugins.call(
        'audio.speech',
        mockModel('audio.speech'),
        { text: '音频不能当角色图' },
        { ownerId: 'local' },
      )
      badId = audio.assets[0]!.assetId
    }
    if (failure === 'missing-file') {
      badId = s.newer.id
      rmSync(s.server.assets.originalPath(badId))
    }
    const profile =
      field === 'period'
        ? { periods: [{ id: 'period', name: '时期', images: [badId] }] }
        : field === 'outfit'
          ? {
              periods: [
                {
                  id: 'period',
                  name: '时期',
                  outfits: [{ id: 'outfit', name: '服饰', images: [badId] }],
                },
              ],
            }
          : { expressions: [{ id: 'expression', name: '表情', images: [badId] }] }
    s.server.library.update('local', s.item.id, {
      description: '仅文字可安全同步',
      ...(field === 'references'
        ? { images: [{ slot: 'main', assetId: badId }] }
        : { profile: LibraryProfile.parse(profile) }),
    })
    const report = await s.read()
    const target = report.cards.find((c) => c.nodeId === s.a.card)!
    const selected = field === 'references' ? 'references' : 'profile'
    expect(
      (
        await s.apply({
          revision: report.revision,
          targets: [{ ...target, mode: 'update', fields: ['description', selected] }],
        })
      ).status,
    ).toBe(422)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('旧设定')
    expect(referenceAssets(s.a.doc, s.a.doc.get(s.a.card)!, 'image')).toEqual([s.old.id])
    expect(
      (
        await s.apply({
          revision: report.revision,
          targets: [{ ...target, mode: 'update', fields: ['description'] }],
        })
      ).status,
    ).toBe(200)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('仅文字可安全同步')
  })

  it('只同步选中画布和字段，旧参考素材、节点候选与另一画布保持原样', async () => {
    const s = await fixture()
    const history = addNode(s.a.doc, 'plein/image')
    addResults(s.a.doc, history, [
      {
        id: 'old-candidate',
        runId: 'old-run',
        port: 'images',
        at: 1,
        value: { type: 'image', assetId: s.old.id },
      },
    ])
    const beforeHistory = s.a.doc.get(history)!.results
    s.updated()
    const report = await s.read()
    expect(report.cards).toHaveLength(2)
    expect(report.cards.map((c) => c.canvasId)).not.toContain(s.foreign.canvasId)
    const card = report.cards.find((c) => c.nodeId === s.a.card)!
    expect(card.changes.map((c) => c.field)).toEqual(
      expect.arrayContaining(['name', 'description', 'voice', 'references']),
    )
    expect(
      (
        await s.apply({
          revision: report.revision,
          targets: [{ ...card, mode: 'update', fields: ['description', 'references'] }],
        })
      ).status,
    ).toBe(200)
    expect(s.a.doc.get(s.a.card)).toMatchObject({
      name: '旧角色',
      params: { description: '新设定', voice: s.item.voice, libraryRevision: report.revision },
    })
    expect(referenceAssets(s.a.doc, s.a.doc.get(s.a.card)!, 'image')).toEqual([s.newer.id])
    expect(s.a.doc.get(s.a.ref)?.assetId).toBe(s.old.id)
    expect(s.a.doc.get(history)!.results).toEqual(beforeHistory)
    expect(s.server.assets.get('local', s.old.id)).not.toBeNull()
    expect(existsSync(s.server.assets.originalPath(s.old.id))).toBe(true)
    expect(s.b.doc.get(s.b.card)).toMatchObject({
      name: '旧角色',
      params: { description: '旧设定' },
    })
    expect(referenceAssets(s.b.doc, s.b.doc.get(s.b.card)!, 'image')).toEqual([s.old.id])
    const remaining = (await s.read()).cards.find((c) => c.nodeId === s.a.card)!
    expect(remaining.changes.map((c) => c.field)).toEqual(expect.arrayContaining(['name', 'voice']))
  })

  it('固定旧版与解除固定都不自动改写内容，库再次更新仍等待明确同步', async () => {
    const s = await fixture()
    s.updated()
    const first = await s.read()
    const target = first.cards.find((c) => c.nodeId === s.a.card)!
    expect(
      (await s.apply({ revision: first.revision, targets: [{ ...target, mode: 'keep' }] })).status,
    ).toBe(200)
    s.server.library.update('local', s.item.id, { description: '第三版设定' })
    const second = await s.read()
    const pinned = second.cards.find((c) => c.nodeId === s.a.card)!
    expect(pinned.pinned).toBe(true)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('旧设定')
    expect(
      (await s.apply({ revision: second.revision, targets: [{ ...pinned, mode: 'unpin' }] }))
        .status,
    ).toBe(200)
    expect(s.a.doc.get(s.a.card)!.params).toMatchObject({
      libraryPinned: false,
      description: '旧设定',
    })
    expect(inputEdges(s.a.doc, s.a.card, 'references')).toHaveLength(1)
  })

  it('来源版本与任一目标在预览后变化，整批拒绝且不部分写入', async () => {
    const s = await fixture()
    s.updated()
    const first = await s.read()
    s.server.library.update('local', s.item.id, { description: '来源又变了' })
    expect(
      (
        await s.apply({
          revision: first.revision,
          targets: first.cards.map((c) => ({ ...c, mode: 'update' })),
        })
      ).status,
    ).toBe(409)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('旧设定')
    const second = await s.read()
    setParams(s.b.doc, s.b.card, { description: '画布 B 手改' })
    expect(
      (
        await s.apply({
          revision: second.revision,
          targets: second.cards.map((c) => ({ ...c, mode: 'update' })),
        })
      ).status,
    ).toBe(409)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('旧设定')
    expect(s.b.doc.get(s.b.card)!.params!.description).toBe('画布 B 手改')
  })

  it('owner/viewer 隔离，重复目标和跨所有者画布不写入', async () => {
    const s = await fixture()
    s.updated()
    const report = await s.read()
    const target = report.cards[0]!
    const body: ApplyLibraryUpdates = {
      revision: report.revision,
      targets: [{ ...target, mode: 'update' }],
    }
    expect((await s.app('other').request(s.path)).status).toBe(404)
    expect((await s.apply(body, s.app('other'))).status).toBe(404)
    expect((await s.apply(body, s.app('local', 'viewer'))).status).toBe(403)
    expect((await s.apply({ ...body, targets: [body.targets[0]!, body.targets[0]!] })).status).toBe(
      400,
    )
    expect(
      (
        await s.apply({
          ...body,
          targets: [{ ...body.targets[0]!, canvasId: s.foreign.canvasId, nodeId: s.foreign.card }],
        })
      ).status,
    ).toBe(400)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('旧设定')
    expect(s.b.doc.get(s.b.card)!.params!.description).toBe('旧设定')
  })

  it('新版参考缺失时拒绝换图，但仍允许只同步文字', async () => {
    const s = await fixture()
    s.server.library.update('local', s.item.id, {
      description: '新文字',
      images: [{ slot: 'main', assetId: 'f'.repeat(64) }],
    })
    const report = await s.read()
    const target = report.cards.find((c) => c.nodeId === s.a.card)!
    expect(
      (
        await s.apply({
          revision: report.revision,
          targets: [{ ...target, mode: 'update', fields: ['references'] }],
        })
      ).status,
    ).toBe(422)
    expect(referenceAssets(s.a.doc, s.a.doc.get(s.a.card)!, 'image')).toEqual([s.old.id])
    expect(
      (
        await s.apply({
          revision: report.revision,
          targets: [{ ...target, mode: 'update', fields: ['description'] }],
        })
      ).status,
    ).toBe(200)
    expect(s.a.doc.get(s.a.card)!.params!.description).toBe('新文字')
  })
})

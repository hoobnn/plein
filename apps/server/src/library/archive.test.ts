import { createDoc, setParam } from '@plein/doc'
import {
  CreateLibraryItem,
  type SaveLibraryCard,
  type SaveLibraryCardResult,
} from '@plein/protocol'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { insertCanvas, insertProject } from '../storage/canvases'
import { addNode, bootServer } from '../testing'
import { archiveLibraryCard } from './archive'
import { librarySyncRoutes } from './sync'

async function fixture() {
  const { server } = await bootServer()
  const project = insertProject(server.db, 'local', '存档项目')
  const canvasId = insertCanvas(server.db, 'local', project, '来源画布')
  const doc = createDoc(server.rooms.get(canvasId).doc, { schedule: (flush) => flush() })
  const nodeId = addNode(doc, 'plein/character', {
    name: '旧名',
    params: { description: '旧描述' },
  })
  const body: SaveLibraryCard = {
    canvasId,
    nodeId,
    expectedLibraryId: null,
    snapshot: {
      kind: 'character',
      name: '提交名称',
      description: '失焦后的新设定',
      projectId: 'spoofed-project',
    },
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
          library: server.library,
          assets: server.assets,
        }),
      )
  const save = (input: unknown = body, actor = app()) =>
    actor.request('/api/library/save-card', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  return { server, doc, project, body, app, save }
}

describe('来源卡片存档', () => {
  it('保存冻结快照并绑定原画布；旧请求重放冲突，不产生第二条记录', async () => {
    const f = await fixture()
    const response = await f.save()
    expect(response.status).toBe(200)
    const result = (await response.json()) as SaveLibraryCardResult
    expect(result).toMatchObject({
      created: true,
      persistence: 'saved',
      item: { name: '提交名称', description: '失焦后的新设定', projectId: f.project },
    })
    expect(f.doc.get(f.body.nodeId)?.params?.libraryId).toBe(result.item.id)
    expect((await f.save()).status).toBe(409)
    expect(f.server.library.list('local')).toHaveLength(1)
    const update = await f.save({ ...f.body, expectedLibraryId: result.item.id })
    expect(await update.json()).toMatchObject({ created: false, item: { id: result.item.id } })
  })

  it('更新保留资产库手选槽位、标签和收藏，已删除关联可重新存入', async () => {
    const f = await fixture()
    const a = 'a'.repeat(64)
    const item = f.server.library.create(
      'local',
      CreateLibraryItem.parse({
        kind: 'character',
        name: '原档案',
        tags: { era: '古代' },
        images: [{ slot: 'portrait', assetId: a }],
      }),
    )
    f.server.library.update('local', item.id, { favorite: true })
    setParam(f.doc, f.body.nodeId, 'libraryId', item.id)
    const response = await f.save({
      ...f.body,
      expectedLibraryId: item.id,
      snapshot: {
        ...f.body.snapshot,
        tags: { era: '现代', gender: '女' },
        images: [{ slot: 'main', assetId: a }],
      },
    })
    expect(await response.json()).toMatchObject({
      created: false,
      item: {
        id: item.id,
        favorite: true,
        tags: { era: '古代', gender: '女' },
        images: [{ slot: 'portrait', assetId: a }],
      },
    })
    f.server.library.remove('local', item.id)
    const replacement = await f.save({ ...f.body, expectedLibraryId: item.id })
    expect(replacement.status).toBe(200)
    expect(await replacement.json()).toMatchObject({ created: true })
    expect(f.doc.get(f.body.nodeId)?.params?.libraryId).not.toBe(item.id)
  })

  it('落盘失败仍返回已创建条目及pending，恢复保存不重复建档', async () => {
    const f = await fixture()
    const room = f.server.rooms.get(f.body.canvasId)
    const flush = vi.spyOn(room, 'flush').mockImplementation(() => {
      throw new Error('磁盘繁忙')
    })
    let id: string
    try {
      const response = await f.save()
      expect(response.status).toBe(202)
      const result = (await response.json()) as SaveLibraryCardResult
      id = result.item.id
      expect(result.persistence).toBe('pending')
      expect(f.doc.get(f.body.nodeId)?.params?.libraryId).toBe(id)
    } finally {
      flush.mockRestore()
    }
    expect(() => room.flush()).not.toThrow()
    expect((await f.save({ ...f.body, expectedLibraryId: id! })).status).toBe(200)
    expect(f.server.library.list('local')).toHaveLength(1)
  })

  it('未授权、非法参数、丢失来源和类型冲突均在写入前拒绝', async () => {
    const f = await fixture()
    expect((await f.save(f.body, f.app('local', 'viewer'))).status).toBe(403)
    expect((await f.save(f.body, f.app('foreign'))).status).toBe(404)
    expect((await f.save({})).status).toBe(400)
    expect((await f.save({ ...f.body, nodeId: 'missing' })).status).toBe(409)
    expect((await f.save({ ...f.body, snapshot: { kind: 'prop', name: '错类型' } })).status).toBe(
      409,
    )
    f.doc.readOnly = true
    expect(() =>
      archiveLibraryCard(f.doc, f.body.nodeId, 'local', f.project, f.server.library),
    ).toThrow('不可写')
    expect(f.server.library.list('local')).toEqual([])
  })

  it('错误类型关联不会覆盖另一种资产，智能体无快照入口使用原卡片内容', async () => {
    const f = await fixture()
    const prop = f.server.library.create(
      'local',
      CreateLibraryItem.parse({ kind: 'prop', name: '道具' }),
    )
    setParam(f.doc, f.body.nodeId, 'libraryId', prop.id)
    const result = archiveLibraryCard(f.doc, f.body.nodeId, 'local', f.project, f.server.library)
    expect(result).toMatchObject({ created: true, item: { name: '旧名', kind: 'character' } })
    expect(f.server.library.get('local', prop.id)?.name).toBe('道具')
    expect(() =>
      archiveLibraryCard(f.doc, addNode(f.doc, 'plein/text'), 'local', f.project, f.server.library),
    ).toThrow('不是资产卡')
  })
})

import { addResults, connect, createDoc } from '@plein/doc'
import type { LibraryItem } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { insertCanvas, insertProject } from '../storage/canvases'
import { addNode, bootServer, request } from '../testing'

const ASSET = 'a'.repeat(64)

async function fixture() {
  const { server } = await bootServer()
  const projectId = insertProject(server.db, 'local', '来源项目')
  const canvasId = insertCanvas(server.db, 'local', projectId, '来源画布')
  const doc = createDoc(server.rooms.get(canvasId).doc, { schedule: (flush) => flush() })
  const create = (body: unknown) =>
    request(server, '/api/library', { method: 'POST', body: JSON.stringify(body) })
  const list = (kind?: string) =>
    request(server, kind ? `/api/library?kind=${kind}` : '/api/library')
  const patch = (id: string, body: unknown) =>
    request(server, `/api/library/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  const remove = (id: string) => request(server, `/api/library/${id}`, { method: 'DELETE' })
  return { server, projectId, canvasId, doc, create, list, patch, remove }
}

describe('资产库条目接口', () => {
  it('创建后能按类别读回，非法参数和不存在的项目被拒绝', async () => {
    const f = await fixture()
    const created = await f.create({ kind: 'prop', name: '旧打火机', description: '磨砂黑' })
    expect(created.status).toBe(201)
    const item = (await created.json()) as LibraryItem
    expect(item).toMatchObject({
      kind: 'prop',
      name: '旧打火机',
      description: '磨砂黑',
      favorite: false,
    })
    expect((await f.list()).status).toBe(200)
    expect(await (await f.list()).json()).toHaveLength(1)
    expect(await (await f.list('prop')).json()).toHaveLength(1)
    expect(await (await f.list('character')).json()).toHaveLength(0)

    expect((await f.create({ kind: 'prop' })).status).toBe(400)
    const tooMany = Array.from({ length: 25 }, (_, index) => ({
      slot: 'main',
      assetId: String(index).padStart(64, '0'),
    }))
    expect((await f.create({ kind: 'prop', name: '太多图', images: tooMany })).status).toBe(400)
    expect((await f.create({ kind: 'unknown', name: 'x' })).status).toBe(400)
    expect((await f.create({ kind: 'prop', name: 'x', projectId: 'pj_不存在' })).status).toBe(404)
    expect(await (await f.list()).json()).toHaveLength(1)
  })

  it('更新名称和收藏立刻生效，只有收藏变动不算修改', async () => {
    const f = await fixture()
    const created = await f.create({ kind: 'prop', name: '旧打火机' })
    const item = (await created.json()) as LibraryItem
    const renamed = await f.patch(item.id, { name: '新打火机', tags: { era: '现代' } })
    expect(renamed.status).toBe(200)
    const updated = (await renamed.json()) as LibraryItem
    expect(updated).toMatchObject({ name: '新打火机', tags: { era: '现代' } })
    expect(updated.updatedAt).toBeGreaterThanOrEqual(item.updatedAt)

    const favorited = await f.patch(item.id, { favorite: true })
    expect(favorited.status).toBe(200)
    const after = (await favorited.json()) as LibraryItem
    expect(after.favorite).toBe(true)
    // 收藏不改动条目内容，列表顺序不跳
    expect(after.updatedAt).toBe(updated.updatedAt)
    expect(after.name).toBe('新打火机')
    // 之后的改名不会把收藏状态抹掉
    const renamedAgain = await f.patch(item.id, { name: '再改一次' })
    expect(((await renamedAgain.json()) as LibraryItem).favorite).toBe(true)
    expect((await f.patch('lib_不存在', { name: 'x' })).status).toBe(404)
  })

  it('解除归属与改到当前项目都写进条目，别人的项目不能占用', async () => {
    const f = await fixture()
    const created = await f.create({ kind: 'prop', name: '水杯', projectId: f.projectId })
    const item = (await created.json()) as LibraryItem
    expect(item.projectId).toBe(f.projectId)

    const detached = await f.patch(item.id, { projectId: null })
    expect(detached.status).toBe(200)
    expect(((await detached.json()) as LibraryItem).projectId).toBeNull()

    const attached = await f.patch(item.id, { projectId: f.projectId })
    expect(attached.status).toBe(200)
    expect(((await attached.json()) as LibraryItem).projectId).toBe(f.projectId)

    expect((await f.patch(item.id, { projectId: 'pj_别人的' })).status).toBe(404)
    expect(f.server.library.get('local', item.id)?.projectId).toBe(f.projectId)
  })

  it('删除条目后列表里没有，再删返回 404', async () => {
    const f = await fixture()
    const created = await f.create({ kind: 'prop', name: '旧打火机' })
    const item = (await created.json()) as LibraryItem
    expect((await f.remove(item.id)).status).toBe(204)
    expect(await (await f.list()).json()).toHaveLength(0)
    expect((await f.remove(item.id)).status).toBe(404)
  })

  it('删除库条目保留画布卡片与参考素材，再存入时创建新的关联', async () => {
    const f = await fixture()
    const image = addNode(f.doc, 'plein/image')
    addResults(f.doc, image, [
      {
        id: 'r1',
        runId: 'run_1',
        port: 'images',
        at: Date.now(),
        value: { type: 'image', assetId: ASSET },
      },
    ])
    const card = addNode(f.doc, 'plein/prop', {
      name: '旧打火机',
      params: { description: '完整设定' },
    })
    expect(connect(f.doc, [image, 'images'], [card, 'references'])).toBeTruthy()

    const saved = await request(f.server, '/api/library/save-card', {
      method: 'POST',
      body: JSON.stringify({
        canvasId: f.canvasId,
        nodeId: card,
        expectedLibraryId: null,
        snapshot: {
          kind: 'prop',
          name: '旧打火机',
          description: '完整设定',
          images: [{ slot: 'main', assetId: ASSET }],
        },
      }),
    })
    expect(saved.status).toBe(200)
    const first = (await saved.json()) as { item: LibraryItem }
    expect(first.item.images).toEqual([{ slot: 'main', assetId: ASSET }])
    expect(f.doc.get(card)?.params?.libraryId).toBe(first.item.id)

    // 删掉库条目：画布上的卡片和参考素材都留着
    expect((await f.remove(first.item.id)).status).toBe(204)
    expect(f.doc.get(card)?.params?.description).toBe('完整设定')
    expect(f.doc.get(image)).toBeTruthy()
    expect([...f.doc.edges()].length).toBe(1)

    // 再存入时创建新的关联：卡片上还留着已删除条目的 id，服务端按它建一条新的
    const again = await request(f.server, '/api/library/save-card', {
      method: 'POST',
      body: JSON.stringify({
        canvasId: f.canvasId,
        nodeId: card,
        expectedLibraryId: first.item.id,
        snapshot: {
          kind: 'prop',
          name: '旧打火机',
          description: '完整设定',
          images: [{ slot: 'main', assetId: ASSET }],
        },
      }),
    })
    expect(again.status).toBe(200)
    const second = (await again.json()) as { item: LibraryItem; created: boolean }
    expect(second.created).toBe(true)
    expect(second.item.id).not.toBe(first.item.id)
    expect(f.doc.get(card)?.params?.libraryId).toBe(second.item.id)
    expect(f.server.library.list('local')).toHaveLength(1)
  })
})

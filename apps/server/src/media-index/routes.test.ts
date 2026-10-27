import { Readable } from 'node:stream'
import { createElement, deleteElements } from '@plein/doc'
import { Hono } from 'hono'
import { describe, expect, it, onTestFinished } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, createCanvas, until } from '../testing'
import { MediaIndexError, createMediaIndex, type MediaIndex } from './service'
import { mediaLibraryRoutes } from './routes'

/** 素材检索的 HTTP 合同：分页游标、筛选条件、来源投影与定位判定。 */
async function setup() {
  const s = await bootServer()
  await until(() => s.server.mediaIndex.ready)
  const { id: canvasId, doc } = await createCanvas(s.server)
  const canvas = s.server.db.$client.prepare('SELECT * FROM canvases WHERE id=?').get(canvasId) as {
    project_id: string
  }
  const index = createMediaIndex({ db: s.server.db, rooms: s.server.rooms })
  index.install()
  await index.rebuild()
  onTestFinished(() => index.close())

  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('principal', { id: c.req.header('x-owner') ?? 'local', role: 'owner' })
    await next()
  })
  app.route('/', mediaLibraryRoutes(index))

  const asset = async (name: string) =>
    s.server.assets.ingest(
      'local',
      Readable.from([`<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`]),
      { mime: 'image/svg+xml', name },
    )
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, init)
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : undefined }
  }
  return { ...s, canvasId, projectId: canvas.project_id, doc, index, app, asset, call }
}

describe('素材检索的合同', () => {
  it('分页游标无效时说明要重新读取首页，好游标能接着取下一页', async () => {
    const s = await setup()
    await s.asset('一号')
    await s.asset('二号')
    const page = await s.call('/api/assets?limit=1')
    expect(page.status).toBe(200)
    expect(page.body.items).toHaveLength(1)
    const cursor = page.body.nextCursor as string
    expect(cursor).toBeTruthy()

    const next = await s.call(`/api/assets?limit=1&cursor=${encodeURIComponent(cursor)}`)
    expect(next.status).toBe(200)
    expect(next.body.items).toHaveLength(1)
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id)

    const bad = await s.call('/api/assets?limit=1&cursor=bad-cursor')
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'invalid' })
    expect(bad.body.message).toContain('分页游标无效')
    // 坏游标不影响重读首页
    const again = await s.call('/api/assets?limit=1')
    expect(again.status).toBe(200)
    expect(again.body.items).toHaveLength(1)
    expect(again.body.nextCursor).toBeTruthy()
  })

  it('换了筛选条件后旧游标不再适用，避免跳过或重复素材', async () => {
    const s = await setup()
    await s.asset('第一张')
    await s.asset('第二张')
    const page = await s.call('/api/assets?limit=1')
    const cursor = page.body.nextCursor as string
    const changed = await s.call(
      `/api/assets?limit=1&kind=image&cursor=${encodeURIComponent(cursor)}`,
    )
    expect(changed.status).toBe(400)
    expect(changed.body.error).toBe('invalid')
  })

  it('来源游标无效时说明要重新读取来源', async () => {
    const s = await setup()
    const a = await s.asset('来源游标素材')
    const nodeId = createElement(s.doc, {
      kind: 'image',
      assetId: a.id,
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    s.index.refreshCanvas(s.canvasId)
    const bad = await s.call(`/api/assets/${a.id}/sources?cursor=bad-cursor`)
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'invalid' })
    // 有效来源仍然可读
    const good = await s.call(`/api/assets/${a.id}/sources`)
    expect(good.status).toBe(200)
    expect(good.body.items).toEqual([
      expect.objectContaining({ type: 'canvas', nodeId, locatable: true }),
    ])
  })

  it('搜索按字面匹配，% 与 _ 不当通配符', async () => {
    const s = await setup()
    await s.asset('边界_100%')
    await s.asset('边界AB杯子')
    const literal = await s.call('/api/assets?q=' + encodeURIComponent('边界_100%'))
    expect(literal.status).toBe(200)
    expect(literal.body.items.map((item: { name: string }) => item.name)).toEqual(['边界_100%'])

    const wildcard = await s.call('/api/assets?q=' + encodeURIComponent('边界_'))
    expect(wildcard.body.items.map((item: { name: string }) => item.name)).toEqual(['边界_100%'])
  })

  it('来源列出定位判定：画布节点还在时可定位，节点删掉后不再声称可定位', async () => {
    const s = await setup()
    const a = await s.asset('可定位素材')
    const nodeId = createElement(s.doc, {
      kind: 'image',
      assetId: a.id,
      x: 0,
      y: 0,
      w: 10,
      h: 10,
    })
    s.index.refreshCanvas(s.canvasId)
    const before = await s.call(`/api/assets/${a.id}/sources`)
    expect(before.status).toBe(200)
    expect(before.body.items).toEqual([
      expect.objectContaining({ type: 'canvas', canvasId: s.canvasId, nodeId, locatable: true }),
    ])

    deleteElements(s.doc, [nodeId])
    s.index.refreshCanvas(s.canvasId)
    const after = await s.call(`/api/assets/${a.id}/sources`)
    expect(after.status).toBe(200)
    // 节点删掉后不再有这条来源，不会把已经不存在的位置说成可定位
    expect(after.body.items).toEqual([])
  })

  it('别人的素材与项目都不出现在检索结果里', async () => {
    const s = await setup()
    await s.asset('本地素材')
    const other = await s.call('/api/assets', { headers: { 'x-owner': 'other' } })
    expect(other.body.items).toEqual([])

    const project = await s.call('/api/assets?projectId=' + s.projectId, {
      headers: { 'x-owner': 'other' },
    })
    expect(project.status).toBe(404)
    expect(project.body.error).toBe('not_found')
  })

  it('一份素材被多个项目引用时，每个项目都能检索到它', async () => {
    const s = await setup()
    const a = await s.asset('跨项目素材')
    createElement(s.doc, { kind: 'image', assetId: a.id, x: 0, y: 0, w: 10, h: 10 })
    s.index.refreshCanvas(s.canvasId)

    // 另一个项目里的画布也引用同一份素材
    const other = await createCanvas(s.server)
    const otherRow = s.server.db.$client
      .prepare('SELECT project_id FROM canvases WHERE id=?')
      .get(other.id) as { project_id: string }
    expect(otherRow.project_id).not.toBe(s.projectId)
    createElement(other.doc, { kind: 'image', assetId: a.id, x: 0, y: 0, w: 10, h: 10 })
    s.index.refreshCanvas(other.id)

    const first = await s.call(`/api/assets?projectId=${s.projectId}`)
    expect(first.status).toBe(200)
    expect(first.body.items.map((item: { id: string }) => item.id)).toContain(a.id)

    const second = await s.call(`/api/assets?projectId=${otherRow.project_id}`)
    expect(second.status).toBe(200)
    expect(second.body.items.map((item: { id: string }) => item.id)).toContain(a.id)
  })

  it('每条素材的来源行在 SQL 层限到三条：返回三条但来源数是真实总数', async () => {
    const s = await setup()
    const asset = await s.asset('来源很多')
    // 给同一条素材登记五条来源：来源都挂在真实画布上，不会被索引的清理删掉
    const put = s.server.db.$client.prepare(
      'INSERT INTO media_sources(owner_id,asset_id,source_type,source_id,locator,canvas_id,label,created_at,adopted) VALUES (?,?,?,?,?,?,?,?,0)',
    )
    for (let i = 0; i < 5; i++)
      put.run('local', asset.id, 'canvas', s.canvasId, `node-${i}`, s.canvasId, `来源${i}`, i)
    const page = await s.call('/api/assets?limit=10')
    expect(page.status).toBe(200)
    const item = page.body.items.find((entry: { id: string }) => entry.id === asset.id)
    expect(item).toBeTruthy()
    // 只返回三条来源行，但来源总数是真的五条
    expect(item.sources).toHaveLength(3)
    expect(item.sourceCount).toBe(5)
  })

  it('一页素材的来源数与来源行一起查，查询次数不随素材条数增长', async () => {
    const s = await setup()
    for (let i = 0; i < 12; i++) await s.asset(`批量${i}`)
    const sqls: string[] = []
    const prepare = s.server.db.$client.prepare.bind(s.server.db.$client)
    s.server.db.$client.prepare = ((sql: string) => {
      sqls.push(sql)
      return prepare(sql)
    }) as never
    const page = s.index.list('local', { q: '', limit: 50 })
    expect(page.items).toHaveLength(12)
    // 来源数与来源行各查一次，不能每条素材再查两次
    // 一页素材的来源数与来源行各查一次：都是按素材批量查的
    expect(sqls.filter((sql) => sql.includes('asset_id IN ('))).toHaveLength(2)
    expect(sqls.filter((sql) => sql.includes('count(*) n FROM media_sources'))).toHaveLength(1)
    expect(
      sqls.filter((sql) =>
        sql.includes('count(*) n FROM media_sources WHERE owner_id=? AND asset_id=?'),
      ),
    ).toHaveLength(0)
    // 来源行在 SQL 层就限到三条，不把整页的来源行都拉回来
    expect(sqls.some((sql) => sql.includes('ROW_NUMBER()'))).toBe(true)
  })
})

describe('素材检索接口的错误映射', () => {
  const stub = (fail: () => never) =>
    ({
      list: fail,
      sources: fail,
    }) as unknown as MediaIndex

  it('索引还没建好时说明正在建立，而不是返回空列表', async () => {
    const app = new Hono<AuthEnv>()
    app.use('*', async (c, next) => {
      c.set('principal', { id: 'local', role: 'owner' })
      await next()
    })
    app.route(
      '/',
      mediaLibraryRoutes(
        stub(() => {
          throw new MediaIndexError('media_index_building', '正在建立素材索引，请稍后重试')
        }),
      ),
    )
    const res = await app.request('/api/assets')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'media_index_building' })
  })

  it('不存在的素材来源返回找不到', async () => {
    const app = new Hono<AuthEnv>()
    app.use('*', async (c, next) => {
      c.set('principal', { id: 'local', role: 'owner' })
      await next()
    })
    app.route(
      '/',
      mediaLibraryRoutes(
        stub(() => {
          throw new MediaIndexError('not_found', '素材不存在')
        }),
      ),
    )
    const res = await app.request('/api/assets/a1/sources')
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'not_found' })
  })
})

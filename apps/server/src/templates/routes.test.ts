import type { UserTemplate } from '@plein/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vite-plus/test'
import type { Server } from '../app'
import type { AuthEnv } from '../auth'
import { bootServer, request } from '../testing'
import { templateRoutes } from './routes'

/** 以指定身份访问模板接口；默认免认证模式下是 owner。 */
function caller(server: Server, id: string, role: 'owner' | 'viewer' = 'owner') {
  return new Hono<AuthEnv>()
    .use('*', (c, next) => {
      c.set('principal', { id, role })
      return next()
    })
    .route('/', templateRoutes(server.db))
}

const data = {
  plein: 1,
  elements: [{ id: 'a', kind: 'text' }],
  edges: [],
}

async function setup() {
  const { server } = await bootServer()
  const list = async () =>
    (await (await request(server, '/api/templates')).json()) as UserTemplate[]
  const save = (body: unknown) =>
    request(server, '/api/templates', { method: 'POST', body: JSON.stringify(body) })
  return { server, list, save }
}

describe('我的模板', () => {
  it('保存后能列出，标题与数据原样落库', async () => {
    const { list, save } = await setup()
    const response = await save({ title: '分镜模板', data })
    expect(response.status).toBe(201)
    const saved = (await response.json()) as UserTemplate
    expect(saved.title).toBe('分镜模板')
    expect(saved.data.elements).toHaveLength(1)
    const listed = await list()
    expect(listed.map((t) => t.title)).toEqual(['分镜模板'])
    expect(listed[0]!.id).toBe(saved.id)
  })

  it('标题为空、超长或数据不合法时拒绝，不落库', async () => {
    const { list, save } = await setup()
    expect((await save({ title: '  ', data })).status).toBe(400)
    expect((await save({ title: 'x'.repeat(61), data })).status).toBe(400)
    expect((await save({ title: '空数据', data: { ...data, elements: [] } })).status).toBe(400)
    expect((await save({ title: '没有数据' })).status).toBe(400)
    expect(await list()).toEqual([])
  })

  it('删除后不再列出；删除不存在的模板报 404', async () => {
    const { server, list } = await setup()
    const created = (await (
      await request(server, '/api/templates', {
        method: 'POST',
        body: JSON.stringify({ title: '待删除', data }),
      })
    ).json()) as UserTemplate
    const removed = await request(server, `/api/templates/${created.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect(await list()).toEqual([])
    expect(
      (await request(server, '/api/templates/${created.id}', { method: 'DELETE' })).status,
    ).toBe(404)
  })

  it('只读成员不能保存或删除模板', async () => {
    const { server } = await setup()
    const created = (await (
      await request(server, '/api/templates', {
        method: 'POST',
        body: JSON.stringify({ title: '所有者模板', data }),
      })
    ).json()) as UserTemplate
    const viewer = caller(server, 'local', 'viewer')
    expect(
      (
        await viewer.request('/api/templates', {
          method: 'POST',
          body: JSON.stringify({ title: 'x', data }),
        })
      ).status,
    ).toBe(403)
    expect(
      (await viewer.request(`/api/templates/${created.id}`, { method: 'DELETE' })).status,
    ).toBe(403)
    // 只读成员仍能读取自己的模板列表
    expect((await viewer.request('/api/templates')).status).toBe(200)
  })

  it('模板只属于自己：别人的模板既读不到也删不掉', async () => {
    const { server } = await setup()
    const created = (await (
      await request(server, '/api/templates', {
        method: 'POST',
        body: JSON.stringify({ title: '别人的模板', data }),
      })
    ).json()) as UserTemplate
    const other = caller(server, 'other')
    expect((await other.request('/api/templates')).status).toBe(200)
    expect(await (await other.request('/api/templates')).json()).toEqual([])
    expect((await other.request(`/api/templates/${created.id}`, { method: 'DELETE' })).status).toBe(
      404,
    )
  })
})

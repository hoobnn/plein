import type { Canvas, LibraryItem, Project } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { bootServer, request } from '../testing'

async function boot() {
  const { server } = await bootServer({ mock: false })
  const call = async <T>(path: string, method = 'GET', body?: unknown) => {
    const res = await request(server, path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
  }
  return { server, call }
}

const PNG = 'a'.repeat(64)

describe('项目与画布', () => {
  it('新建项目自带第一张画布，可以再加画布，删除项目连画布一起删', async () => {
    const { call } = await boot()
    const { body: p } = await call<Project>('/api/projects', 'POST', { title: '短剧一' })
    expect(p.canvases).toBe(1)
    expect(p.lastCanvasId).toBeTruthy()

    const { body: second } = await call<Canvas>('/api/canvases', 'POST', {
      title: '第二集',
      projectId: p.id,
    })
    expect(second.projectId).toBe(p.id)
    const { body: list } = await call<Canvas[]>(`/api/projects/${p.id}/canvases`)
    expect(list.map((c) => c.title)).toEqual(['第二集', '画布 1'])
    const { body: again } = await call<Project>(`/api/projects/${p.id}`)
    expect(again.canvases).toBe(2)
    expect(again.lastCanvasId).toBe(second.id)

    expect((await call(`/api/projects/${p.id}`, 'PATCH', { title: '改名' })).body).toMatchObject({
      title: '改名',
    })
    expect((await call(`/api/projects/${p.id}`, 'DELETE')).status).toBe(204)
    expect((await call(`/api/canvases/${second.id}`)).status).toBe(404)
  })

  it('不指定项目建画布时自动建同名项目；指定别人的项目返回 404', async () => {
    const { call } = await boot()
    const { body: c } = await call<Canvas>('/api/canvases', 'POST', { title: '散页' })
    const { body: projects } = await call<Project[]>('/api/projects')
    expect(projects.find((p) => p.id === c.projectId)?.title).toBe('散页')
    expect((await call('/api/canvases', 'POST', { projectId: 'pj_nope' })).status).toBe(404)
  })
})

describe('资产库', () => {
  it('新建、筛选、收藏、记录使用、改名、删除', async () => {
    const { call } = await boot()
    const { body: p } = await call<Project>('/api/projects', 'POST', { title: '短剧' })
    const created = await call<LibraryItem>('/api/library', 'POST', {
      kind: 'character',
      name: '林夏',
      projectId: p.id,
      description: '二十岁，黑长直',
      tags: { gender: '女', age: '青年' },
      voice: { provider: 'plein/doubao-speech', voiceId: 'S_1' },
      images: [{ slot: 'main', assetId: PNG }],
    })
    expect(created.status).toBe(201)
    const item = created.body
    expect(item).toMatchObject({
      kind: 'character',
      projectId: p.id,
      favorite: false,
      usedAt: null,
    })

    await call('/api/library', 'POST', { kind: 'scene', name: '天台' })
    const { body: characters } = await call<LibraryItem[]>('/api/library?kind=character')
    expect(characters.map((i) => i.name)).toEqual(['林夏'])

    const fav = await call<LibraryItem>(`/api/library/${item.id}`, 'PATCH', { favorite: true })
    expect(fav.body.favorite).toBe(true)
    // 只收藏不改修改时间
    expect(fav.body.updatedAt).toBe(item.updatedAt)
    expect((await call(`/api/library/${item.id}/use`, 'POST')).status).toBe(204)
    const renamed = await call<LibraryItem>(`/api/library/${item.id}`, 'PATCH', { name: '林夏夏' })
    expect(renamed.body).toMatchObject({
      name: '林夏夏',
      favorite: true,
      description: '二十岁，黑长直',
    })
    expect(renamed.body.usedAt).toBeTypeOf('number')

    // 删项目后条目保留，变成不归属项目
    await call(`/api/projects/${p.id}`, 'DELETE')
    expect((await call<LibraryItem>(`/api/library/${item.id}`)).body.projectId).toBeNull()

    expect((await call(`/api/library/${item.id}`, 'DELETE')).status).toBe(204)
    expect((await call(`/api/library/${item.id}`)).status).toBe(404)
  })

  it('拒绝不合法的输入', async () => {
    const { call } = await boot()
    expect((await call('/api/library', 'POST', { kind: 'monster', name: 'x' })).status).toBe(400)
    expect((await call('/api/library', 'POST', { kind: 'style', name: '' })).status).toBe(400)
    expect(
      (
        await call('/api/library', 'POST', {
          kind: 'style',
          name: 'x',
          images: [{ slot: 'ref', assetId: 'nope' }],
        })
      ).status,
    ).toBe(400)
    expect(
      (await call('/api/library', 'POST', { kind: 'style', name: 'x', projectId: 'pj_nope' }))
        .status,
    ).toBe(404)
  })
})

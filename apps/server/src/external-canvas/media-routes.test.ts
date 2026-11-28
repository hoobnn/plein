import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Hono } from 'hono'
import sharp from 'sharp'
import { expect, it, vi } from 'vite-plus/test'
import type { RemoteMedia } from '@plein/protocol'
import { externalMediaPath } from '@plein/protocol'
import type { AuthEnv } from '../auth'
import { bootServer, createCanvas } from '../testing'
import { externalMediaRoutes } from './media-routes'
import type { ExternalMediaProvider } from './media-provider'

async function setup(resolveTarget?: ExternalMediaProvider['resolveTarget']) {
  const { server } = await bootServer()
  const { id, doc } = await createCanvas(server)
  const bytes = await sharp({ create: { width: 32, height: 24, background: 'red', channels: 3 } })
    .png()
    .toBuffer()
  const media: RemoteMedia = {
    nodeId: '1001',
    assetId: '2001',
    title: '开场',
    kind: 'image',
    replaceable: true,
  }
  const listMedia = vi.fn(async () => [media])
  const download = vi.fn<ExternalMediaProvider['download']>(async (_target, _r, file) => {
    await writeFile(file, bytes)
    return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const replace = vi.fn<NonNullable<ExternalMediaProvider['replace']>>(
    async (_target, _r, file) => {
      expect(await readFile(file)).toEqual(bytes)
      expect(file).toMatch(/source\.png$/)
      return 'new-asset'
    },
  )
  const publish = vi.fn<NonNullable<ExternalMediaProvider['publish']>>(
    async (_target, source, op) => {
      expect(await readFile(source.path)).toEqual(bytes)
      return { nodeId: 'node_published', assetId: op }
    },
  )
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('principal', { id: c.req.header('owner') ?? 'local', role: 'owner' })
    await next()
  })
  app.route(
    '/',
    externalMediaRoutes(server.db, server.rooms, server.assets, 1024 * 1024, {
      'jimeng-novel': { listMedia, download, replace, resolveTarget },
      'jimeng-canvas': { listMedia, download, publish },
    }),
  )
  const call = (
    op: 'import' | 'list' | 'replace' | 'publish',
    rest: Record<string, string> = {},
    owner = 'local',
  ) =>
    app.request(externalMediaPath(id, op), {
      method: 'POST',
      headers: { owner, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'jimeng-novel',
        target: '1000',
        nodeId: media.nodeId,
        assetId: media.assetId,
        ...rest,
      }),
    })
  return { call, doc, media, download, replace, publish, listMedia, server }
}

it('按确切版本导入原生素材，重试只保留一个元素，替换时读取已认证用户的原件', async () => {
  const f = await setup()
  expect(await (await f.call('list')).json()).toEqual([f.media])
  const res = await f.call('import')
  expect(res.status, await res.clone().text()).toBe(201)
  const r = (await res.json()) as { elementId: string; assetId: string }
  expect(f.doc.get(r.elementId)).toMatchObject({ assetId: r.assetId, kind: 'image', name: '开场' })
  const retry = await f.call('import')
  expect(await retry.json()).toEqual(r)
  expect(f.doc.size).toBe(1)
  expect(await (await f.call('replace', { localAssetId: r.assetId })).json()).toEqual({
    assetId: 'new-asset',
  })
})

it('按已核验的空间复用导入，其他团队的同号素材保留独立元素', async () => {
  const f = await setup(async (target) => (target === '1000' ? '7/1000' : target))
  const fromDefault = await f.call('import')
  expect(fromDefault.status).toBe(201)
  const element = await fromDefault.json()
  const sameSpace = await f.call('import', { target: '7/1000' })
  expect(sameSpace.status).toBe(200)
  expect(await sameSpace.json()).toEqual(element)
  const other = await f.call('import', { target: '8/1000' })
  expect(other.status).toBe(201)
  expect(f.download.mock.calls.map(([target]) => target)).toEqual(['7/1000', '7/1000', '8/1000'])
  expect(f.doc.size).toBe(2)
})

it('下载中切换选片时拒绝导入并清理暂存', async () => {
  const f = await setup()
  f.listMedia.mockResolvedValueOnce([f.media]).mockResolvedValueOnce([])
  expect((await f.call('import')).status).toBe(409)
  const file = f.download.mock.calls[0]![2]
  await expect(readFile(file)).rejects.toThrow()
  expect(f.doc.size).toBe(0)
})

it('拒绝伪装为媒体的内容与不匹配的校验回执', async () => {
  const f = await setup()
  f.download.mockImplementationOnce(async (_target, _r, file) => {
    await writeFile(file, '#EXTM3U\nhttps://example.invalid/test\n')
  })
  expect((await f.call('import')).status).toBe(422)
  f.download.mockImplementationOnce(async (_target, _r, file) => {
    await writeFile(file, 'bad')
    return { size: 20, sha256: 'f'.repeat(64) }
  })
  expect((await f.call('import')).status).toBe(422)
  expect(f.doc.size).toBe(0)
})

it('其他所有者或过期的节点选择无法调用下载，也不会触发上传', async () => {
  const f = await setup()
  expect((await f.call('import', {}, 'stranger')).status).toBe(404)
  expect(f.listMedia).not.toHaveBeenCalled()
  expect((await f.call('import', { assetId: 'stale' })).status).toBe(409)
  expect((await f.call('replace', { localAssetId: '0'.repeat(64) })).status).toBe(422)
  expect(f.download).not.toHaveBeenCalled()
  expect(f.replace).not.toHaveBeenCalled()
})

it('上传后回执丢失时复用持久操作身份，再次导出只核验已确认节点', async () => {
  const f = await setup()
  const imported = await f.call('import')
  const { assetId } = (await imported.json()) as { assetId: string }
  const input = {
    provider: 'jimeng-canvas',
    target: '5f2d3acb-ffbd-4b8d-afcd-158617e2da47',
    localAssetId: assetId,
  }
  f.publish.mockRejectedValueOnce(new Error('超时'))
  expect((await f.call('publish', input)).status).toBe(422)
  const op = f.publish.mock.calls[0]![2]
  expect(f.publish.mock.calls[0]![3]).toBe(false)
  for (const completed of [false, true]) {
    const res = await f.call('publish', input)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual({ nodeId: 'node_published', assetId: op })
    expect(f.publish.mock.calls.at(-1)?.slice(2)).toEqual([op, completed])
  }
})

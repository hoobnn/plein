import { Readable } from 'node:stream'
import type { Asset } from '@plein/protocol'
import { Hono } from 'hono'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AssetStore } from '../assets/store'
import type { AuthEnv } from '../auth'
import { openDb } from '../storage/db'
import { tempDir } from '../testing'
import { assetRoutes } from './assets'
import { renderableInline } from './files'

let store: AssetStore
let db: ReturnType<typeof openDb>
let svg: Asset
let png: Asset

/** 身份由 requireAuth 注入，这里用请求头指定，默认本机用户 */
const app = () => {
  const server = new Hono<AuthEnv>()
  server.use('*', async (c, next) => {
    c.set('principal', { id: c.req.header('x-user') ?? 'local', role: 'owner' })
    await next()
  })
  server.route('/', assetRoutes(store))
  return server
}
const get = (path: string, init: RequestInit = {}) => app().request(path, init)

beforeAll(async () => {
  const dir = tempDir('plein-assets-')
  db = openDb(dir)
  store = new AssetStore(dir, db, 16 * 1024 * 1024)
  await store.init()
  const put = (body: string | Buffer, mime: string, name: string) =>
    store.ingest('local', Readable.from([Buffer.from(body)]), { mime, name })
  svg = await put(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'image/svg+xml',
    'a.svg',
  )
  png = await put(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#c00' } })
      .png()
      .toBuffer(),
    'image/png',
    '封面 1.png',
  )
})

afterAll(() => db.$client.close())

describe('资产下发', () => {
  it('SVG 内联显示但禁止执行脚本', async () => {
    const res = await get(`/api/assets/${svg.id}`)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(res.headers.get('content-security-policy')).toMatch(/^default-src 'none'/)
  })

  it('?download 按原文件名作为附件下载，中文名按 RFC 5987 编码', async () => {
    const res = await get(`/api/assets/${png.id}?download`)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('封面 1.png')}`,
    )
  })

  it('Range 超出文件 416 并给出总长度；HEAD 只有头', async () => {
    const bad = await get(`/api/assets/${png.id}`, { headers: { range: `bytes=${png.size}-` } })
    expect(bad.status).toBe(416)
    expect(bad.headers.get('content-range')).toBe(`bytes */${png.size}`)

    const head = await get(`/api/assets/${png.id}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(png.size))
    expect((await head.arrayBuffer()).byteLength).toBe(0)
  })

  it('id 不是哈希、变体不存在或不认识、资产属于别人：都是 404', async () => {
    expect((await get('/api/assets/..%2F..%2Fetc')).status).toBe(404)
    expect((await get(`/api/assets/${png.id.toUpperCase()}`)).status).toBe(404)
    expect((await get(`/api/assets/${png.id}/poster`)).status).toBe(404)
    expect((await get(`/api/assets/${png.id}/nope`)).status).toBe(404)
    expect((await get(`/api/assets/${png.id}/thumb-256`)).status).toBe(200)
    const other = { headers: { 'x-user': 'someone-else' } }
    expect((await get(`/api/assets/${png.id}`, other)).status).toBe(404)
    expect((await get(`/api/assets/${png.id}/meta`, other)).status).toBe(404)
  })
})

describe('renderableInline', () => {
  it('能执行脚本的类型不内联', () => {
    expect(renderableInline('image/png')).toBe(true)
    expect(renderableInline('video/mp4')).toBe(true)
    expect(renderableInline('text/plain')).toBe(true)
    expect(renderableInline('text/html')).toBe(false)
    expect(renderableInline('application/xhtml+xml')).toBe(false)
    expect(renderableInline('application/javascript')).toBe(false)
  })
})

import { API, AssetVariant } from '@plein/protocol'
import { Hono } from 'hono'
import type { AuthEnv } from '../auth'
import { type AssetStore, UploadTooLargeError, VARIANT_TYPES } from '../assets/store'
import { sendFile } from './files'

const HASH = /^[0-9a-f]{64}$/
const notFound = { error: 'not_found', message: '资产不存在' }

/**
 * 上传：请求体就是文件内容（不用 multipart，便于流式处理大文件），
 * 类型取 Content-Type，文件名取 X-File-Name（URL 编码）。
 */
export function assetRoutes(store: AssetStore) {
  return new Hono<AuthEnv>()
    .post(API.assets, async (c) => {
      const body = c.req.raw.body
      if (!body) return c.json({ error: 'invalid', message: '请求体为空' }, 400)
      const mime = (c.req.header('content-type') ?? 'application/octet-stream')
        .split(';')[0]!
        .trim()
        .toLowerCase()
      let name = 'untitled'
      try {
        name = decodeURIComponent(c.req.header('x-file-name') ?? name).slice(0, 255) || name
      } catch {}
      try {
        const asset = await store.ingest(c.var.principal.id, body, { mime, name })
        return c.json(asset, 201)
      } catch (err) {
        if (err instanceof UploadTooLargeError)
          return c.json({ error: 'too_large', message: err.message }, 413)
        throw err
      }
    })
    .get('/api/assets/:id/meta', (c) => {
      const asset = store.get(c.var.principal.id, c.req.param('id'))
      return asset ? c.json(asset) : c.json(notFound, 404)
    })
    .on(['GET', 'HEAD'], '/api/assets/:id/:variant?', async (c) => {
      const id = c.req.param('id')
      if (!HASH.test(id)) return c.json(notFound, 404)
      const asset = store.get(c.var.principal.id, id)
      if (!asset) return c.json(notFound, 404)
      const v = c.req.param('variant')
      if (!v) {
        return sendFile(c, store.originalPath(id), {
          mime: asset.mime,
          immutable: true,
          download: c.req.query('download') !== undefined ? asset.name : undefined,
        })
      }
      const variant = AssetVariant.safeParse(v)
      if (!variant.success || !asset.variants.includes(variant.data)) return c.json(notFound, 404)
      return sendFile(c, store.variantPath(id, variant.data), {
        mime: VARIANT_TYPES[variant.data].mime,
        immutable: true,
      })
    })
}

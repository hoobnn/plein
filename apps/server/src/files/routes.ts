import { Hono } from 'hono'
import { type AssetStore, UploadTooLargeError } from '../assets/store'
import { sendFile } from '../http/files'
import type { FileTickets } from './tickets'

const gone = { error: 'not_found', message: '票据不存在、已过期或已用过' }

/** 内容是 base64 之类时 Content-Length 之外的上限由票据决定 */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let size = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > max) throw new UploadTooLargeError(`文件超过上限 ${max} 字节`)
        controller.enqueue(chunk)
      },
    }),
  )
}

/**
 * 外部 AI 用的文件进出端点。凭据就是路径里的票据（短期、绑定用户），不带 Cookie 或令牌，
 * 所以放在 /mcp 下，与 MCP 入口一样绕过桌面端 Cookie 校验；Host/Origin 校验仍然生效。
 *
 * - PUT|POST /mcp/upload/:ticket 上传文件（请求体就是内容），一次性票据
 * - GET|HEAD /mcp/files/:ticket  下载资产原件或导出包，只读，过期前可重复取
 */
export function fileRoutes(deps: {
  tickets: FileTickets
  assets: AssetStore
  canvasApi?: (ownerId: string, request: Request) => Promise<Response>
}) {
  const { tickets, assets, canvasApi } = deps
  return new Hono()
    .on(['PUT', 'POST'], '/mcp/upload/:ticket', async (c) => {
      const grant = tickets.takeUpload(c.req.param('ticket'))
      if (!grant) return c.json(gone, 404)
      const body = c.req.raw.body
      if (!body) return c.json({ error: 'invalid', message: '请求体为空' }, 400)
      const declared = Number(c.req.header('content-length'))
      if (Number.isFinite(declared) && declared > grant.maxBytes)
        return c.json(
          { error: 'too_large', message: `文件超过票据上限 ${grant.maxBytes} 字节` },
          413,
        )
      try {
        const asset = await assets.ingest(grant.ownerId, capped(body, grant.maxBytes), {
          mime: grant.mime,
          name: grant.name,
        })
        return c.json({ asset_id: asset.id, ...asset }, 201)
      } catch (err) {
        if (
          err instanceof UploadTooLargeError ||
          (err as Error).cause instanceof UploadTooLargeError
        )
          return c.json({ error: 'too_large', message: (err as Error).message }, 413)
        throw err
      }
    })
    .on(['GET', 'HEAD'], '/mcp/files/:ticket', async (c) => {
      const grant = tickets.getDownload(c.req.param('ticket'))
      if (!grant) return c.json(gone, 404)
      const { target, ownerId } = grant
      if (target.kind === 'asset') {
        // 签发后资产可能被删，或归属变了：以现在的库为准
        const asset = assets.get(ownerId, target.assetId)
        if (!asset) return c.json(gone, 404)
        return sendFile(c, assets.originalPath(asset.id), {
          mime: asset.mime,
          download: target.name ?? asset.name,
        })
      }
      if (!canvasApi) return c.json(gone, 404)
      const res = await canvasApi(
        ownerId,
        new Request(`http://plein.internal${target.path}`, {
          method: 'GET',
          signal: c.req.raw.signal,
        }),
      )
      if (!res.ok || !res.body) return c.json(gone, 404)
      const headers = new Headers()
      for (const k of ['content-type', 'content-disposition', 'content-length'])
        if (res.headers.has(k)) headers.set(k, res.headers.get(k)!)
      headers.set('Cache-Control', 'no-store')
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(c.req.method === 'HEAD' ? null : res.body, { status: 200, headers })
    })
}

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { Context } from 'hono'

/**
 * 发送本地文件，支持 Range（视频 / 音频拖动进度需要）。
 * 资产按内容寻址、不可变，允许长期缓存。
 */
export async function sendFile(
  c: Context,
  path: string,
  opts: { mime: string; immutable?: boolean; download?: string },
) {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return c.json({ error: 'not_found', message: '文件不存在' }, 404)

  const inline = renderableInline(opts.mime)
  const headers = new Headers({
    // 浏览器能执行脚本的类型（HTML、XML、JS…）一律不按原类型下发，防止同源存储型 XSS
    'Content-Type': inline ? opts.mime : 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': opts.immutable ? 'private, max-age=31536000, immutable' : 'no-cache',
  })
  if (opts.download || !inline) {
    headers.set(
      'Content-Disposition',
      opts.download
        ? `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`
        : 'attachment',
    )
  }
  // SVG 可以内嵌脚本：内联显示但禁止执行；其余非媒体类型加沙箱兜底
  if (opts.mime === 'image/svg+xml')
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  else if (!inline) headers.set('Content-Security-Policy', "sandbox; default-src 'none'")

  const size = info.size
  const range = parseRange(c.req.header('range'), size)
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }
  const [start, end] = range ?? [0, size - 1]
  const length = size === 0 ? 0 : end - start + 1
  headers.set('Content-Length', String(length))
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  if (c.req.method === 'HEAD' || length === 0) {
    return new Response(null, { status: range ? 206 : 200, headers })
  }
  const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
  return new Response(stream, { status: range ? 206 : 200, headers })
}

/** 只支持单段 Range：bytes=a-b / bytes=a- / bytes=-n */
export function parseRange(
  header: string | undefined,
  size: number,
): [number, number] | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return [start, end]
}

/** 可以按原类型内联显示的 MIME：图片、音视频、PDF 和纯文本（不会执行脚本） */
export function renderableInline(mime: string) {
  return (
    /^(image|video|audio)\/[a-z0-9.+-]+$/.test(mime) ||
    mime === 'application/pdf' ||
    mime === 'text/plain' ||
    mime === 'text/markdown'
  )
}

import type { MiddlewareHandler } from 'hono'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function hostname(host: string) {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return ''
  }
}

/**
 * 浏览器侧的跨站防护：
 * - Origin 必须与 Host 同源（或来自本机，如 Vite 开发服务器），挡住恶意网页对本机服务的跨站请求与 WebSocket；
 * - 免认证模式下 Host 必须是本机名，挡住 DNS 重绑定。
 */
export function originGuard(opts: {
  authRequired: boolean
  allowedHosts: string[]
}): MiddlewareHandler {
  const allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()))
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase()
    const name = hostname(host)
    if (!opts.authRequired && !LOOPBACK.has(name) && !allowed.has(name)) {
      return c.json(
        { error: 'forbidden_host', message: `不允许的 Host：${host}，可设置 PLEIN_ALLOWED_HOSTS` },
        403,
      )
    }
    const origin = c.req.header('origin')
    if (origin && origin !== 'null') {
      let o: URL | null = null
      try {
        o = new URL(origin)
      } catch {}
      const ok =
        o && (o.host.toLowerCase() === host || LOOPBACK.has(o.hostname) || allowed.has(o.hostname))
      if (!ok) return c.json({ error: 'forbidden_origin', message: '跨站请求被拒绝' }, 403)
    } else if (origin === 'null') {
      return c.json({ error: 'forbidden_origin', message: '跨站请求被拒绝' }, 403)
    }
    await next()
  }
}

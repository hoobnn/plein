import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

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

export const DESKTOP_COOKIE = 'plein_desktop'

/**
 * 桌面端令牌校验：桌面端主进程每次启动生成随机令牌，写进自己窗口的 Cookie，
 * 服务端只接受带这个 Cookie 的请求（含 WebSocket 握手）
 */
export function desktopGuard(token: string): MiddlewareHandler {
  const expected = Buffer.from(token)
  return async (c, next) => {
    const got = Buffer.from(getCookie(c, DESKTOP_COOKIE) ?? '')
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return c.json({ error: 'forbidden', message: '只允许 plein 桌面端访问' }, 403)
    }
    await next()
  }
}

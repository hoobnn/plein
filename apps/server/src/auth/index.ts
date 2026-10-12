import { timingSafeEqual } from 'node:crypto'
import {
  API,
  LOCAL_PRINCIPAL,
  LoginRequest,
  type Principal,
  type SessionInfo,
} from '@plein/protocol'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import type { AuthMode } from '../config'
import type { Secrets } from '../storage/secrets'

/**
 * 认证边界：所有 HTTP / WS 入口都经它得到 Principal。
 * 0.1.0 只有本机放行与访问令牌两种实现；以后接账号体系（如 Better Auth）只需换掉 AuthProvider。
 */
export interface AuthProvider {
  readonly required: boolean
  authenticate(c: Context): Promise<Principal | null>
}

export type AuthEnv = { Variables: { principal: Principal } }

const COOKIE = 'plein_session'

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 本机模式：所有请求视为所有者 */
export class LocalAuth implements AuthProvider {
  readonly required = false
  async authenticate() {
    return LOCAL_PRINCIPAL
  }
}

/** 令牌模式：Bearer 令牌或登录后签发的签名 Cookie */
export class TokenAuth implements AuthProvider {
  readonly required = true
  constructor(private secrets: Secrets) {}

  async authenticate(c: Context) {
    const header = c.req.header('authorization')
    if (header?.startsWith('Bearer ') && safeEqual(header.slice(7), this.secrets.token)) {
      return LOCAL_PRINCIPAL
    }
    const session = await getSignedCookie(c, this.secrets.cookieSecret, COOKIE)
    return session === LOCAL_PRINCIPAL.id ? LOCAL_PRINCIPAL : null
  }

  checkToken(token: string) {
    return safeEqual(token, this.secrets.token)
  }
}

export function createAuth(mode: AuthMode, secrets: Secrets) {
  const provider: AuthProvider = mode === 'token' ? new TokenAuth(secrets) : new LocalAuth()

  /** 未认证返回 401；认证结果放进 c.var.principal */
  const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const principal = await provider.authenticate(c)
    if (!principal) return c.json({ error: 'unauthorized', message: '需要访问令牌' }, 401)
    c.set('principal', principal)
    await next()
  }

  /** 会话与登录接口（不经过 requireAuth） */
  const routes = new Hono<AuthEnv>()
    .get(API.session, async (c) => {
      const principal = await provider.authenticate(c)
      if (!principal) return c.json({ error: 'unauthorized', message: '需要访问令牌' }, 401)
      return c.json({ principal, authRequired: provider.required } satisfies SessionInfo)
    })
    .post(API.login, async (c) => {
      if (!(provider instanceof TokenAuth)) {
        return c.json({ principal: LOCAL_PRINCIPAL, authRequired: false } satisfies SessionInfo)
      }
      const body = LoginRequest.safeParse(await c.req.json().catch(() => null))
      if (!body.success || !provider.checkToken(body.data.token)) {
        return c.json({ error: 'invalid_token', message: '令牌不正确' }, 401)
      }
      await setSignedCookie(c, COOKIE, LOCAL_PRINCIPAL.id, secrets.cookieSecret, {
        httpOnly: true,
        sameSite: 'Strict',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      })
      return c.json({ principal: LOCAL_PRINCIPAL, authRequired: true } satisfies SessionInfo)
    })
    .post(API.logout, (c) => {
      deleteCookie(c, COOKIE, { path: '/' })
      return c.body(null, 204)
    })

  return { provider, requireAuth, routes }
}

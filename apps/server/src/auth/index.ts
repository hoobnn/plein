import { LOCAL_PRINCIPAL, type Principal, type SessionInfo } from '@plein/protocol'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthMode } from '../config'
import type { DB } from '../storage/db'
import type { Secrets } from '../storage/secrets'

/**
 * 认证边界：所有 HTTP / WS 入口都经它得到 Principal。
 * - none：本机免登录，所有请求视为所有者；
 * - password：Better Auth 邮箱密码登录。0.1.0 只允许创建一个所有者账号，
 *   多用户注册、角色、团队等账号体系以后在 Better Auth 上扩展。
 */
export interface AuthProvider {
  readonly required: boolean
  authenticate(c: Context): Promise<Principal | null>
}

export type AuthEnv = { Variables: { principal: Principal } }

/** 所有者账号：第一个创建的用户 */
function ownerId(db: DB): string | null {
  const row = db.prepare('SELECT id FROM user ORDER BY createdAt LIMIT 1').get() as
    | { id: string }
    | undefined
  return row?.id ?? null
}

/** 已有所有者账号时，本机模式也以它的身份读写，切换模式不会“看不到”数据 */
function localPrincipal(db: DB): Principal {
  const id = ownerId(db)
  return id ? { id, role: 'owner' } : LOCAL_PRINCIPAL
}

export async function createAuth(
  mode: AuthMode,
  db: DB,
  secrets: Secrets,
  opts: { publicUrl?: string } = {},
) {
  const options = {
    database: db,
    secret: secrets.authSecret,
    basePath: '/api/auth',
    // 本地自部署的访问地址不固定（localhost、局域网 IP、反向代理域名），按请求推断；Host 由 originGuard 把关
    baseURL: opts.publicUrl ?? { allowedHosts: ['*'] },
    // 同源校验由 originGuard 负责；这里信任请求自身的源
    trustedOrigins: (req) => {
      const host = req?.headers.get('host')
      return host ? [`http://${host}`, `https://${host}`] : []
    },
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    session: { expiresIn: 60 * 60 * 24 * 30 },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // 只允许创建第一个账号（所有者）
          before: async () => (ownerId(db) ? false : undefined),
          // 本机模式下创建的数据归到所有者名下
          after: async (user) => {
            db.prepare("UPDATE canvases SET owner_id = ? WHERE owner_id = 'local'").run(user.id)
            db.prepare("UPDATE OR IGNORE assets SET owner_id = ? WHERE owner_id = 'local'").run(
              user.id,
            )
          },
        },
      },
    },
  } satisfies BetterAuthOptions
  // 先建表再初始化，避免 Better Auth 启动时报表缺失
  const { runMigrations } = await getMigrations(options)
  await runMigrations()
  const auth = betterAuth(options)

  const provider: AuthProvider =
    mode === 'password'
      ? {
          required: true,
          async authenticate(c) {
            const s = await auth.api.getSession({ headers: c.req.raw.headers })
            // 0.1.0 只有所有者一个账号
            return s ? { id: s.user.id, role: 'owner' } : null
          },
        }
      : { required: false, authenticate: async () => localPrincipal(db) }

  /** 未认证返回 401；认证结果放进 c.var.principal */
  const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const principal = await provider.authenticate(c)
    if (!principal) return c.json({ error: 'unauthorized', message: '请先登录' }, 401)
    c.set('principal', principal)
    await next()
  }

  /** 会话查询与 Better Auth 接口（不经过 requireAuth） */
  const routes = new Hono<AuthEnv>()
    .get('/api/session', async (c) => {
      const principal = await provider.authenticate(c)
      return c.json({
        principal,
        authRequired: provider.required,
        needsSetup: provider.required && !ownerId(db),
      } satisfies SessionInfo)
    })
    .all('/api/auth/*', async (c) => {
      if (mode !== 'password') return c.json({ error: 'auth_disabled', message: '未开启登录' }, 404)
      return auth.handler(c.req.raw)
    })

  return { auth, provider, requireAuth, routes }
}

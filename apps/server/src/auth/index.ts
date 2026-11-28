import { LOCAL_PRINCIPAL, type Principal, type SessionInfo } from '@plein/protocol'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { asc, eq, sql } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import type { AuthMode } from '../config'
import type { DB } from '../storage/db'
import {
  account,
  agentSessions,
  assets,
  canvases,
  canvasCheckpoints,
  checkpointAssets,
  impactDecisions,
  jobGroups,
  jobs,
  libraryItems,
  localWorkspaceAdoptions,
  mediaSources,
  projects,
  session,
  templates,
  user,
  verification,
  voices,
} from '../storage/schema'
import type { Secrets } from '../storage/secrets'

/**
 * 认证边界：所有 HTTP / WS 入口都经它得到 Principal。
 * - none：本机免登录，所有请求视为所有者；
 * - password：Better Auth 邮箱密码登录。0.1.0 只允许创建一个所有者账号，
 *   多用户注册、角色、团队等账号体系以后在 Better Auth 上扩展。
 *
 *   数据访问例外：本文件直连 Drizzle 是有意为之，属于 CONTRIBUTING「数据访问」里的基础设施直连。
 *   Better Auth 的 drizzleAdapter 要的就是同一个 db 实例与认证表 schema，
 *   认证表和业务表共用一份迁移，不能把适配器接到别处的连接上；
 *   「本机模式的数据归到所有者名下」也必须在创建账号的钩子里跟着同一个库走。
 *   这里的查询只碰认证表与所有者归属，不含业务表的通用读写。
 */
export interface AuthProvider {
  readonly required: boolean
  authenticate(c: Context): Promise<Principal | null>
}

export type AuthEnv = { Variables: { principal: Principal } }

/** 所有者账号：第一个创建的用户 */
export function firstOwnerId(db: DB): string | null {
  const row = db.select({ id: user.id }).from(user).orderBy(asc(user.createdAt)).limit(1).get()
  return row?.id ?? null
}

/** 单账号产品的本机数据随首个所有者一起迁移，启动时也修复旧版本只迁过画布、素材的工作区。 */
function adoptLocalWorkspace(db: DB, owner: string) {
  db.transaction((tx) => {
    if (
      tx
        .select()
        .from(localWorkspaceAdoptions)
        .where(eq(localWorkspaceAdoptions.ownerId, owner))
        .get()
    )
      return
    // 检查点钉住素材的联合外键；两端都换完所有者后统一校验。
    tx.run(sql`PRAGMA defer_foreign_keys = ON`)
    for (const table of [
      projects,
      canvases,
      jobs,
      jobGroups,
      agentSessions,
      impactDecisions,
      templates,
      libraryItems,
      canvasCheckpoints,
    ]) {
      tx.run(sql`UPDATE ${table} SET owner_id = ${owner} WHERE owner_id = 'local'`)
    }
    // 历史账号可能已经有相同的素材、来源或平台音色，保留两边原有的元数据。
    for (const table of [assets, checkpointAssets, mediaSources, voices]) {
      tx.run(sql`UPDATE OR IGNORE ${table} SET owner_id = ${owner} WHERE owner_id = 'local'`)
    }
    tx.insert(localWorkspaceAdoptions).values({ ownerId: owner }).run()
  })
}

/** 已有所有者账号时，本机模式也以它的身份读写，切换模式不会“看不到”数据 */
function localPrincipal(db: DB): Principal {
  const id = firstOwnerId(db)
  return id ? { id, role: 'owner' } : LOCAL_PRINCIPAL
}

export async function createAuth(
  mode: AuthMode,
  db: DB,
  secrets: Secrets,
  opts: { publicUrl?: string; externalCanvas?: boolean; onOwnerCreated?: () => void } = {},
) {
  const existingOwner = firstOwnerId(db)
  if (existingOwner) adoptLocalWorkspace(db, existingOwner)
  const options = {
    // 认证表和业务表在同一份 Drizzle schema 和迁移里（storage/schema.ts）
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: { user, session, account, verification },
    }),
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
          before: async () => (firstOwnerId(db) ? false : undefined),
          // 本机模式下创建的数据归到所有者名下
          after: async (created) => {
            adoptLocalWorkspace(db, created.id)
            opts.onOwnerCreated?.()
          },
        },
      },
    },
  } satisfies BetterAuthOptions
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
        ...(opts.externalCanvas ? { externalCanvas: true } : {}),
        needsSetup: provider.required && !firstOwnerId(db),
      } satisfies SessionInfo)
    })
    .all('/api/auth/*', async (c) => {
      if (mode !== 'password') return c.json({ error: 'auth_disabled', message: '未开启登录' }, 404)
      return auth.handler(c.req.raw)
    })

  return { auth, provider, requireAuth, routes, existingOwner }
}

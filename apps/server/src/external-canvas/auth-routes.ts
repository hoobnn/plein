import {
  ExternalAuthRequest,
  type ExternalAuthAction,
  type ExternalAuthState,
  type ExternalPlatform,
} from '@plein/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AuthEnv } from '../auth'
import { ownsCanvas } from '../storage/canvases'
import type { DB } from '../storage/db'
import { CliFailure, runCli } from './cli'

type Pending = Extract<ExternalAuthState, { status: 'pending' }>
type Session = { deviceCode: string; view: Pending } | { status: 'expired' | 'denied' }
const origin = 'https://jimeng.jianying.com'
const challengeData = z.object({
  deviceCode: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._~-]{0,2047}$/),
  verificationUriComplete: z.string().nullish(),
  verificationUri: z.string().optional(),
  userCode: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 -]{0,127}$/)
    .optional(),
  expiresAt: z.string().optional(),
})
const envelope = z.object({
  data: z.object({
    status: z.enum(['logged_in', 'reused', 'authorization_required']),
    state: z.object({ loggedIn: z.boolean() }).optional(),
    challenge: challengeData.optional(),
  }),
})

function officialUrl(value: string, deviceCode: string) {
  const url = new URL(value)
  if (url.origin !== origin || url.username || url.password)
    throw new Error('invalid authorization URL')
  if (
    decodeURIComponent(url.href).includes(deviceCode) ||
    [...url.searchParams.keys()].some((key) => /^device_?code$/i.test(key))
  )
    throw new Error('invalid public authorization URL')
  return url
}

function projectChallenge(c: z.infer<typeof challengeData>, now: number): Session {
  const url = officialUrl(c.verificationUriComplete || c.verificationUri || '', c.deviceCode)
  for (const nested of url.searchParams.getAll('verification_uri'))
    officialUrl(nested, c.deviceCode)
  const fallback = !c.verificationUriComplete
  if (fallback && (!c.userCode || c.userCode === c.deviceCode))
    throw new Error('missing public user code')
  const expiry = c.expiresAt ? Date.parse(c.expiresAt) : now + 10 * 60_000
  if (!Number.isFinite(expiry)) throw new Error('invalid challenge expiry')
  if (expiry <= now) return { status: 'expired' }
  return {
    deviceCode: c.deviceCode,
    view: {
      status: 'pending',
      verificationUrl: url.href,
      expiresAt: new Date(expiry).toISOString(),
      ...(fallback ? { userCode: c.userCode } : {}),
    },
  }
}

const canvasStatus = z.object({ ok: z.literal(true), data: z.object({ loggedIn: z.boolean() }) })
const novelStatus = z.object({ logged_in: z.boolean() })

/** Each action awaits one bounded CLI invocation. Nothing polls after the HTTP response. */
export function externalAuthRoutes(db: DB, cli: typeof runCli = runCli) {
  const app = new Hono<AuthEnv>()
  const base = '/api/canvases/:canvas/external/auth' as const
  const sessions = new Map<ExternalPlatform, Session>()
  const active = new Map<
    ExternalPlatform,
    { action: ExternalAuthAction; promise: Promise<ExternalAuthState> }
  >()

  async function handle(
    provider: ExternalPlatform,
    action: ExternalAuthAction,
  ): Promise<ExternalAuthState> {
    const novel = provider === 'jimeng-novel'
    const exec = (args: string[]) =>
      cli(novel ? 'jimeng-novel' : 'dreamina-canvas', [
        ...args,
        ...(novel ? ['-j'] : ['--non-interactive', '--format', 'json']),
      ])
    let current = sessions.get(provider)
    if (current && 'view' in current && Date.parse(current.view.expiresAt) <= Date.now()) {
      current = { status: 'expired' }
      sessions.set(provider, current)
    }
    if (action === 'status' || (action === 'finish' && (!current || !('view' in current)))) {
      const raw = JSON.parse(await exec(novel ? ['status'] : ['auth', 'status']))
      const logged = novel
        ? novelStatus.parse(raw).logged_in
        : canvasStatus.parse(raw).data.loggedIn
      if (logged) {
        sessions.delete(provider)
        return { status: 'authenticated' }
      }
      return current ? ('view' in current ? current.view : current) : { status: 'signed-out' }
    }
    if (action === 'start' && current && 'view' in current) return current.view
    let args: string[]
    if (action === 'start') {
      args = novel
        ? ['login', '--non-interactive', ...(current ? ['--restart'] : [])]
        : ['auth', 'login', '--no-browser']
    } else {
      if (!current || !('view' in current)) return { status: 'signed-out' }
      args = [
        ...(novel ? ['login', '--wait'] : ['auth', 'wait']),
        '--device-code',
        current.deviceCode,
        '--timeout',
        '8s',
      ]
    }
    try {
      const raw: unknown = JSON.parse(await exec(args))
      if (novel) z.object({ status: z.enum(['ok', 'success']) }).parse(raw)
      else z.object({ ok: z.literal(true) }).parse(raw)
      const { data } = envelope.parse(raw)
      if (data.status === 'logged_in' || data.status === 'reused') {
        if (data.state?.loggedIn === false) throw new Error('inconsistent authorization response')
        sessions.delete(provider)
        return { status: 'authenticated' }
      }
      if (!data.challenge || action !== 'start') throw new Error('invalid authorization state')
      current = projectChallenge(data.challenge, Date.now())
      sessions.set(provider, current)
      return 'view' in current ? current.view : current
    } catch (e) {
      if (action === 'finish' && e instanceof CliFailure) {
        if (
          (e.authCode === 40011 ||
            ['wait_timeout', 'authorization_pending'].includes(e.authReason ?? '')) &&
          current &&
          'view' in current
        )
          return current.view
        if (e.authCode === 40014 || e.authReason === 'authorization_expired')
          current = { status: 'expired' }
        else if (
          ['authorization_denied', 'access_denied', 'user_denied', 'user_cancelled'].includes(
            e.authReason ?? '',
          )
        )
          current = { status: 'denied' }
        else throw e
        sessions.set(provider, current)
        return current
      }
      throw e
    }
  }

  app.use(`${base}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store')
    const owner = c.var.principal
    if (owner.role !== 'owner' || !ownsCanvas(db, owner.id, c.req.param('canvas')!))
      return c.json({ error: 'not_found', message: '画布不存在' }, 404)
    await next()
  })
  app.onError((err, c) =>
    c.json(
      {
        error: 'external_auth_failed',
        message: err instanceof CliFailure ? err.message : '即梦授权回执不兼容，请检查 CLI 版本。',
      },
      422,
    ),
  )
  for (const action of ['status', 'start', 'finish'] as const) {
    app.post(`${base}/${action}`, async (c) => {
      const body = ExternalAuthRequest.safeParse(await c.req.json().catch(() => null))
      if (!body.success) return c.json({ error: 'invalid', message: '请选择有效的即梦平台' }, 400)
      const { provider } = body.data
      const running = active.get(provider)
      if (running) {
        if (running.action === action) return c.json(await running.promise)
        return c.json({ error: 'busy', message: '此平台正在核对授权，请稍后再试。' }, 409)
      }
      const promise = handle(provider, action)
      active.set(provider, { action, promise })
      try {
        return c.json(await promise)
      } finally {
        active.delete(provider)
      }
    })
  }
  return app
}

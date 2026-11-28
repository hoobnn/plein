import { Hono } from 'hono'
import { it, expect, vi } from 'vite-plus/test'
import { externalAuthPath, type ExternalAuthAction, type ExternalPlatform } from '@plein/protocol'
import type { AuthEnv } from '../auth'
import { bootServer, createCanvas } from '../testing'
import { CliFailure, runCli } from './cli'
import { externalAuthRoutes } from './auth-routes'

const deviceCode = 'private-device-code-123'
const verificationUrl =
  'https://jimeng.jianying.com/ai-tool/cli-auth?verification_uri=https%3A%2F%2Fjimeng.jianying.com%2Fpassport%2Fopen%2Fscan_user_code%2F%3Fuser_code%3Dpublic'
function challenge(provider: ExternalPlatform, url = verificationUrl, extra = {}) {
  return JSON.stringify({
    ...(provider === 'jimeng-novel' ? { status: 'success' } : { ok: true }),
    data: {
      status: 'authorization_required',
      challenge: {
        deviceCode,
        verificationUriComplete: url,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        ...extra,
      },
      nextCommand: 'do not expose private arguments',
    },
  })
}
async function setup() {
  const { server } = await bootServer()
  const { id } = await createCanvas(server)
  const cli = vi.fn<typeof runCli>()
  const app = new Hono<AuthEnv>()
  app.use('*', async (c, next) => {
    c.set('principal', { id: c.req.header('owner') ?? 'local', role: 'owner' })
    await next()
  })
  app.route('/', externalAuthRoutes(server.db, cli))
  const call = (
    action: ExternalAuthAction,
    provider: ExternalPlatform = 'jimeng-novel',
    body = {},
    owner = 'local',
  ) =>
    app.request(externalAuthPath(id, action), {
      method: 'POST',
      headers: { 'content-type': 'application/json', owner },
      body: JSON.stringify({ provider, ...body }),
    })
  return { cli, call }
}

it.each(['jimeng-novel', 'jimeng-canvas'] as const)(
  '复用 %s 待授权流程，设备码仅交回官方 CLI',
  async (provider) => {
    const { call, cli } = await setup()
    cli
      .mockResolvedValueOnce(challenge(provider))
      .mockRejectedValueOnce(new CliFailure('timeout', 40011))
      .mockResolvedValueOnce(
        JSON.stringify({
          ...(provider === 'jimeng-novel' ? { status: 'success' } : { ok: true }),
          data: { status: 'logged_in', state: { loggedIn: true, credential: 'secret' } },
        }),
      )
    const [r1, r2] = await Promise.all([call('start', provider), call('start', provider)])
    expect(r1.headers.get('cache-control')).toBe('no-store')
    const text = await r1.text()
    expect(text).not.toContain(deviceCode)
    expect(text).not.toContain('nextCommand')
    expect(JSON.parse(text)).toMatchObject({ status: 'pending', verificationUrl })
    expect(await r2.json()).toEqual(JSON.parse(text))
    expect(cli).toHaveBeenCalledTimes(1)
    expect(await (await call('finish', provider)).json()).toMatchObject({
      status: 'pending',
      verificationUrl,
    })
    expect(cli.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['--device-code', deviceCode, '--timeout', '8s']),
    )
    expect(await (await call('finish', provider)).json()).toEqual({ status: 'authenticated' })
    expect(cli).toHaveBeenCalledTimes(3)
  },
)

it('终止过期设备码，在下次用户主动开始时换新短剧 challenge', async () => {
  const { cli, call } = await setup()
  cli
    .mockResolvedValueOnce(challenge('jimeng-novel'))
    .mockRejectedValueOnce(new CliFailure('expired', 40014))
    .mockResolvedValueOnce(challenge('jimeng-novel'))
  await call('start')
  expect(await (await call('finish')).json()).toEqual({ status: 'expired' })
  await call('start')
  expect(cli.mock.calls[2]?.[1]).toEqual(
    expect.arrayContaining(['login', '--non-interactive', '--restart']),
  )
})

it('状态探测按两种正式 CLI 的不同信封读取，绝不新建挑战', async () => {
  const { cli, call } = await setup()
  cli
    .mockResolvedValueOnce(JSON.stringify({ logged_in: false, status: 'not_logged_in' }))
    .mockResolvedValueOnce(JSON.stringify({ ok: true, data: { loggedIn: true } }))
  expect(await (await call('status', 'jimeng-novel')).json()).toEqual({ status: 'signed-out' })
  expect(await (await call('status', 'jimeng-canvas')).json()).toEqual({ status: 'authenticated' })
  expect(cli.mock.calls.map(([, a]) => a)).toEqual([
    ['status', '-j'],
    ['auth', 'status', '--non-interactive', '--format', 'json'],
  ])
})

it('不接受外部授权地址、凭据型地址与重定向到外域的嵌套验证地址', async () => {
  const { cli, call } = await setup()
  for (const url of [
    'https://outside.invalid/auth',
    'https://user@jimeng.jianying.com/auth',
    'https://jimeng.jianying.com/auth?verification_uri=https://outside.invalid',
    'https://jimeng.jianying.com/auth?device_code=' + deviceCode,
  ]) {
    cli.mockResolvedValueOnce(challenge('jimeng-novel', url))
    const res = await call('start')
    expect(res.status).toBe(422)
    expect(await res.text()).not.toContain(url)
  }
})

it('只允许画布所有者，拒绝客户端提供私有码', async () => {
  const { call, cli } = await setup()
  expect((await call('start', 'jimeng-canvas', {}, 'another')).status).toBe(404)
  expect((await call('finish', 'jimeng-canvas', { deviceCode })).status).toBe(400)
  expect(cli).not.toHaveBeenCalled()
})

it('通用官方授权页只返回可供用户填写的公开码', async () => {
  const { cli, call } = await setup()
  cli.mockResolvedValueOnce(
    challenge('jimeng-canvas', '', {
      verificationUri: 'https://jimeng.jianying.com/auth',
      userCode: 'ABCD',
    }),
  )
  expect(await (await call('start', 'jimeng-canvas')).json()).toMatchObject({
    status: 'pending',
    verificationUrl: 'https://jimeng.jianying.com/auth',
    userCode: 'ABCD',
  })
})

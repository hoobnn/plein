import { Hono } from 'hono'
import { describe, expect, it } from 'vite-plus/test'
import { originGuard } from './guard'

const app = (opts: { authRequired?: boolean; allowedHosts?: string[] } = {}) =>
  new Hono()
    .use('*', originGuard({ authRequired: false, allowedHosts: [], ...opts }))
    .get('/', (c) => c.text('ok'))

const status = async (a: Hono, headers: Record<string, string>) =>
  (await a.request('/', { headers })).status

describe('originGuard', () => {
  it('免认证模式只认本机 Host，挡住 DNS 重绑定；PLEIN_ALLOWED_HOSTS 可放行', async () => {
    expect(await status(app(), { host: '127.0.0.1:8787' })).toBe(200)
    expect(await status(app(), { host: '[::1]:8787' })).toBe(200)
    expect(await status(app(), { host: 'evil.com' })).toBe(403)
    expect(await status(app({ allowedHosts: ['Evil.com'] }), { host: 'evil.com:8787' })).toBe(200)
    // 需要登录时不限制 Host
    expect(await status(app({ authRequired: true }), { host: 'plein.example.com' })).toBe(200)
  })

  it('Origin 必须同源或来自本机；null 与无法解析的 Origin 一律拒绝', async () => {
    const host = { host: '127.0.0.1:8787' }
    expect(await status(app(), { ...host, origin: 'http://127.0.0.1:8787' })).toBe(200)
    expect(await status(app(), { ...host, origin: 'http://localhost:5173' })).toBe(200)
    expect(await status(app(), { ...host, origin: 'https://evil.example' })).toBe(403)
    expect(await status(app(), { ...host, origin: 'null' })).toBe(403)
    expect(await status(app(), { ...host, origin: 'not a url' })).toBe(403)
  })
})

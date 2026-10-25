import { Hono } from 'hono'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, request } from '../testing'
import { pluginInstallRoutes } from './install-routes'

const body = () =>
  zipSync({
    'plein-plugin.json': new TextEncoder().encode(
      JSON.stringify({
        id: 'acme/http-install',
        version: '1.0.0',
        name: 'HTTP安装',
        engines: { plein: '^0.1.0' },
        main: { server: 'server.mjs' },
      }),
    ),
    'server.mjs': new TextEncoder().encode('throw new Error("not executed")'),
  })

describe('插件安装 HTTP 边界', () => {
  it('本机 owner 先预检再确认，取消和重复提交均不执行入口', async () => {
    const f = await bootServer()
    expect(await (await request(f.server, '/api/plugins/install/status')).json()).toMatchObject({
      available: true,
    })
    const p = await request(f.server, '/api/plugins/install/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: body(),
    })
    expect(p.status).toBe(200)
    const { token } = (await p.json()) as { token: string }
    const installed = await request(f.server, '/api/plugins/install/confirm', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    expect(installed.status).toBe(201)
    expect(await installed.json()).toMatchObject({
      id: 'acme/http-install',
      enabled: false,
      status: 'disabled',
    })
    expect(
      (
        await request(f.server, '/api/plugins/install/confirm', {
          method: 'POST',
          body: JSON.stringify({ token }),
        })
      ).status,
    ).toBe(409)
    expect(
      (await request(f.server, '/api/plugins/install/confirm', { method: 'POST', body: '{}' }))
        .status,
    ).toBe(400)
    expect(
      (await request(f.server, '/api/plugins/install/preview', { method: 'POST', body: body() }))
        .status,
    ).toBe(400)
  })
  it('登录模式不可安装，非 owner 不能读取预检或安装接口', async () => {
    const app = new Hono<AuthEnv>()
    app.use('*', async (c, next) => {
      c.set('principal', { id: 'o', role: 'owner' })
      await next()
    })
    app.route('/', pluginInstallRoutes(null))
    expect(await (await app.request('/api/plugins/install/status')).json()).toMatchObject({
      available: false,
    })
    expect(
      (await app.request('/api/plugins/install/preview', { method: 'POST', body: body() })).status,
    ).toBe(403)
    const viewer = new Hono<AuthEnv>()
    viewer.use('*', async (c, next) => {
      c.set('principal', { id: 'v', role: 'viewer' })
      await next()
    })
    viewer.route('/', pluginInstallRoutes(null))
    for (const path of ['status', 'preview', 'confirm'])
      expect((await viewer.request(`/api/plugins/install/${path}`)).status).toBe(403)
  })
  it('上传超过 20 MiB 在解析前被拒绝', async () => {
    const f = await bootServer()
    const response = await request(f.server, '/api/plugins/install/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: new Uint8Array(20 * 1024 * 1024 + 1),
    })
    expect(response.status).toBe(413)
  })
  it('免登录但监听非回环地址时禁用安装，不信任伪造 Host 或转发头', async () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.1']) {
      const f = await bootServer({ config: { host, auth: 'none' } })
      const headers = {
        host: 'localhost',
        'x-forwarded-for': '127.0.0.1',
        'content-type': 'application/zip',
      }
      const status = await request(f.server, '/api/plugins/install/status', { headers })
      expect(await status.json()).toMatchObject({ available: false })
      expect(
        (
          await request(f.server, '/api/plugins/install/preview', {
            method: 'POST',
            headers,
            body: body(),
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await request(f.server, '/api/plugins/install/confirm', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ token: '00000000-0000-4000-8000-000000000000' }),
          })
        ).status,
      ).toBe(403)
    }
  })
})

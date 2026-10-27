import type { Catalog, ProviderConfigView, ProviderTestResult } from '@plein/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, request } from '../testing'
import { pluginRoutes } from './routes'

/** 直接调应用：免认证模式要求 Host 是本机名 */
async function boot() {
  const { server } = await bootServer()
  const call = async <T = Record<string, unknown>>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const res = await request(server, path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
  }
  return { server, call }
}

describe('平台配置接口', () => {
  it('未知平台返回 404，不合规设置与未知密钥都被拒绝', async () => {
    const { call } = await boot()
    expect((await call('/api/providers/acme/none/config')).status).toBe(404)
    expect((await call('/api/providers/acme/none/config', 'PUT', { enabled: true })).status).toBe(
      404,
    )
    const invalid = await call('/api/providers/plein/mock/config', 'PUT', {
      settings: { latencyMs: -1 },
    })
    expect(invalid.status).toBe(400)
    const unknown = await call<{ message: string }>('/api/providers/plein/mock/config', 'PUT', {
      secrets: { OTHER: 'x' },
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.message).toContain('未知的密钥：OTHER')
  })

  it('保存后回读设置与密钥状态，密钥本身不回显', async () => {
    const { call } = await boot()
    const saved = await call('/api/providers/plein/mock/config', 'PUT', {
      secrets: { MOCK_API_KEY: 'sk-123' },
      settings: { latencyMs: 321 },
    })
    expect(saved.status).toBe(200)
    expect(saved.body).toMatchObject({
      enabled: true,
      secrets: { MOCK_API_KEY: true },
      settings: { latencyMs: 321 },
    })
    expect(JSON.stringify(saved.body)).not.toContain('sk-123')
    const view = (await call<ProviderConfigView>('/api/providers/plein/mock/config')).body
    expect(view).toMatchObject({ secrets: { MOCK_API_KEY: true }, settings: { latencyMs: 321 } })
  })

  it('不是所有者不能改平台设置', async () => {
    const { server } = await boot()
    const app = new Hono<AuthEnv>()
    app.use('*', async (c, next) => {
      c.set('principal', { id: 'other', role: 'editor' })
      await next()
    })
    app.route('/', pluginRoutes(server.plugins))
    const res = await app.request('/api/providers/plein/mock/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { message: string }).message).toBe('只有所有者可以修改平台设置')
  })
})

describe('默认模型接口', () => {
  it('能力或模型不合法时拒绝，合法时写入并只影响新节点', async () => {
    const { call } = await boot()
    const bad = await call<{ message: string }>('/api/model-defaults', 'PUT', {
      capability: 'text.nope',
      model: 'plein/mock:chat',
    })
    expect(bad.status).toBe(400)
    expect(bad.body.message).toBe('能力或模型不正确')
    const mismatch = await call<{ message: string }>('/api/model-defaults', 'PUT', {
      capability: 'text.chat',
      model: 'plein/mock:image',
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.message).toBe('模型没启用或不支持这种能力')

    const ok = await call<{ defaultModels: Record<string, string> }>('/api/model-defaults', 'PUT', {
      capability: 'text.chat',
      model: 'plein/mock:chat',
    })
    expect(ok.status).toBe(200)
    expect(ok.body.defaultModels).toMatchObject({ 'text.chat': 'plein/mock:chat' })
    const catalog = (await call<Catalog>('/api/catalog')).body
    expect(catalog.defaultModels['text.chat']).toBe('plein/mock:chat')
    // 新建节点按新的默认模型写参数
    expect(catalog.nodes.find((n) => n.type === 'plein/llm')!.defaults).toMatchObject({
      model: 'plein/mock:chat',
    })
  })
})

describe('平台检查接口', () => {
  it('返回检查范围与时间，未知平台返回 404', async () => {
    const { call } = await boot()
    const ok = (await call<ProviderTestResult>('/api/providers/plein/mock/test', 'POST')).body
    expect(ok).toEqual({
      ok: true,
      scope: 'connection',
      modelAccess: 'unverified',
      checkedAt: expect.any(Number),
      message: '连接检查通过；尚未验证具体模型、资源权限或余额',
    })
    expect((await call('/api/providers/acme/none/test', 'POST')).status).toBe(404)
  })
})

describe('兼容渠道', () => {
  it('远端 HTTP 地址被拒绝，合法配置同步模型身份与显式能力', async () => {
    const { call } = await boot()
    const rejected = await call<{ message: string }>(
      '/api/providers/plein/compatible/config',
      'PUT',
      { settings: { baseURL: 'http://gateway.example.com/v1', model: 'example-chat' } },
    )
    expect(rejected.status).toBe(400)
    expect(rejected.body.message).toContain('远端渠道必须使用 HTTPS')

    const saved = await call('/api/providers/plein/compatible/config', 'PUT', {
      enabled: true,
      settings: { baseURL: 'https://gateway.example.com/v1', model: 'example-chat', vision: true },
      secrets: { COMPATIBLE_API_KEY: 'test-only-not-a-real-key' },
    })
    expect(saved.status).toBe(200)
    const catalog = (await call<Catalog>('/api/catalog')).body
    const provider = catalog.providers.find((p) => p.id === 'plein/compatible')!
    expect(provider.enabled).toBe(true)
    expect(provider.models[0]).toMatchObject({ title: 'example-chat', features: ['vision'] })
    const initial = provider.models[0]!.id

    // 换模型后身份跟着变，目录里不再有旧模型
    await call('/api/providers/plein/compatible/config', 'PUT', {
      settings: { baseURL: 'https://gateway.example.com/v1', model: 'another-chat', vision: true },
    })
    const updated = (await call<Catalog>('/api/catalog')).body
    const after = updated.providers.find((p) => p.id === 'plein/compatible')!
    expect(after.models[0]!.id).not.toBe(initial)
    expect(after.models.map((m) => m.id)).not.toContain(initial)
  })
})

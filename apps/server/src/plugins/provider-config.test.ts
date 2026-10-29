import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Catalog, ProviderConfigView, ProviderTestResult } from '@plein/protocol'
import { Hono } from 'hono'
import { describe, expect, it } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, request, tempDir } from '../testing'
import { ProviderConfigStore } from './config-store'
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

describe('平台密钥组存储', () => {
  it('加载时迁移旧扁平密钥，重复加载保持幂等', () => {
    const dir = tempDir()
    const file = join(dir, 'providers.json')
    writeFileSync(
      file,
      JSON.stringify({
        'acme/demo': {
          enabled: true,
          settings: { region: 'cn' },
          secrets: { APP_ID: 'app', TOKEN: 'token' },
        },
      }),
    )
    const store = new ProviderConfigStore(dir)
    const config = store.get('acme/demo')
    expect(config.credentials).toHaveLength(1)
    expect(config.credentials[0]).toMatchObject({
      label: '默认',
      secrets: { APP_ID: 'app', TOKEN: 'token' },
    })
    expect(config.activeCredential).toBe(config.credentials[0]!.id)
    expect(config.secrets).toEqual({ APP_ID: 'app', TOKEN: 'token' })
    const saved = readFileSync(file, 'utf8')
    expect(JSON.parse(saved)['acme/demo']).not.toHaveProperty('secrets')

    const restored = new ProviderConfigStore(dir)
    expect(readFileSync(file, 'utf8')).toBe(saved)
    expect(restored.get('acme/demo')).toEqual(config)
  })

  it('扁平 secrets 补丁作用于当前组，没有组时自动创建默认组', () => {
    const store = new ProviderConfigStore(tempDir())
    const created = store.update('acme/demo', { secrets: { APP_ID: 'app', TOKEN: 'token' } })
    expect(created.credentials[0]).toMatchObject({ label: '默认' })
    expect(created.activeCredential).toBe(created.credentials[0]!.id)

    const team = store.addCredential('acme/demo', '团队', { APP_ID: 'team', TOKEN: 'team-token' })
    store.setActiveCredential('acme/demo', team.credentials[1]!.id)
    const updated = store.update('acme/demo', {
      secrets: { APP_ID: null, TOKEN: '', EXTRA: 'extra' },
    })
    expect(updated.secrets).toEqual({ EXTRA: 'extra' })
    expect(updated.credentials[0]!.secrets).toEqual({ APP_ID: 'app', TOKEN: 'token' })
  })

  it('支持新增、修改、切换和删除密钥组，删除当前组后选择剩余第一组', () => {
    const store = new ProviderConfigStore(tempDir())
    const personal = store.addCredential('acme/demo', ' 个人 ', { TOKEN: 'one' })
    const personalId = personal.credentials[0]!.id
    expect(personal.activeCredential).toBe(personalId)
    const withTeam = store.addCredential('acme/demo', '团队', { TOKEN: 'two' })
    const teamId = withTeam.credentials[1]!.id
    expect(withTeam.activeCredential).toBe(personalId)

    const patched = store.patchCredential('acme/demo', personalId, {
      label: ' 私人 ',
      secrets: { TOKEN: null, OTHER: 'other' },
    })
    expect(patched.credentials[0]).toMatchObject({ label: '私人', secrets: { OTHER: 'other' } })
    expect(store.setActiveCredential('acme/demo', teamId).secrets).toEqual({ TOKEN: 'two' })
    const removed = store.removeCredential('acme/demo', teamId)
    expect(removed.activeCredential).toBe(personalId)
    expect(removed.credentials.map((credential) => credential.id)).toEqual([personalId])
    const empty = store.removeCredential('acme/demo', personalId)
    expect(empty.activeCredential).toBeUndefined()
    expect(empty.secrets).toEqual({})
  })

  it('标签去空白，同平台不可重复且最长 40 字', () => {
    const store = new ProviderConfigStore(tempDir())
    const config = store.addCredential('acme/demo', '个人', {})
    expect(() => store.addCredential('acme/demo', ' PERSONAL ', {})).not.toThrow()
    expect(() => store.addCredential('acme/demo', ' 个人 ', {})).toThrow('不可重复')
    expect(() =>
      store.patchCredential('acme/demo', config.credentials[0]!.id, { label: 'personal' }),
    ).toThrow('不可重复')
    expect(() => store.addCredential('acme/demo', '   ', {})).toThrow('1–40')
    expect(() => store.addCredential('acme/demo', 'x'.repeat(41), {})).toThrow('1–40')
  })
})

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

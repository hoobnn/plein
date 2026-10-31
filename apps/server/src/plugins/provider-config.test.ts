import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Catalog, ProviderConfigView, ProviderTestResult } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { AuthEnv } from '../auth'
import { bootServer, createCanvas, request, tempDir } from '../testing'
import { VoiceStore } from '../voices/store'
import { ProviderConfigStore } from './config-store'
import { pluginRoutes } from './routes'

/** 直接调应用：免认证模式要求 Host 是本机名 */
async function boot() {
  const { server, dataDir } = await bootServer()
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
  return { server, dataDir, call }
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

  it('空 credentials 与旧扁平密钥并存时也迁移为默认组', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify({
        'acme/demo': {
          enabled: true,
          settings: {},
          credentials: [],
          secrets: { TOKEN: 'token' },
        },
      }),
    )
    const config = new ProviderConfigStore(dir).get('acme/demo')
    expect(config.credentials).toHaveLength(1)
    expect(config.credentials[0]).toMatchObject({ label: '默认', secrets: { TOKEN: 'token' } })
    expect(config.activeCredential).toBe(config.credentials[0]!.id)
    expect(config.secrets).toEqual({ TOKEN: 'token' })
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

  it('空扁平 secrets 补丁不创建默认组', () => {
    const store = new ProviderConfigStore(tempDir())
    const config = store.update('acme/demo', { secrets: {} })
    expect(config.credentials).toEqual([])
    expect(config.activeCredential).toBeUndefined()
    expect(config.secrets).toEqual({})
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
    for (const credentials of [
      { add: [{ label: '团队', secrets: { OTHER: 'x' } }] },
      { update: [{ id: 'missing', secrets: { OTHER: 'x' } }] },
    ]) {
      const response = await call<{ message: string }>('/api/providers/plein/mock/config', 'PUT', {
        credentials,
      })
      expect(response.status).toBe(400)
      expect(response.body.message).toContain('未知的密钥：OTHER')
    }
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
    expect(view).toMatchObject({
      secrets: { MOCK_API_KEY: true },
      settings: { latencyMs: 321 },
      activeCredential: expect.any(String),
      credentials: [
        {
          label: '默认',
          secrets: { MOCK_API_KEY: true },
          configured: true,
        },
      ],
    })
  })

  it('配置视图按密钥组汇总未完成的平台调用和音色', async () => {
    const { server, call } = await boot()
    const config = server.plugins.configs.update('plein/mock', {
      secrets: { MOCK_API_KEY: 'personal' },
    })
    const credentialId = config.activeCredential!
    const { id: canvasId } = await createCanvas(server)
    const pendingJob = (
      id: string,
      status: 'queued' | 'canceled' | 'failed',
      dismissed = false,
    ) => {
      server.runs.store.insert({
        id,
        ownerId: 'local',
        canvasId,
        nodeId: 'speech',
        nodeType: 'plein/speech',
      })
      server.runs.store.update(id, {
        status,
        ...(dismissed
          ? { recovery: JSON.stringify({ state: 'remote_pending', dismissed: true }) }
          : {}),
      })
      server.runs.store.journal(id).set('pending', {
        state: 'pending',
        remoteId: `remote-${id}`,
        provider: 'plein/mock',
        credentialId,
      })
    }
    pendingJob('credential-usage-job', 'queued')
    pendingJob('credential-usage-canceled', 'canceled')
    pendingJob('credential-usage-dismissed', 'failed', true)
    server.runs.store.journal('credential-usage-job').set('done', {
      state: 'done',
      result: { outputs: [], assets: [] },
      provider: 'plein/mock',
      credentialId,
    })
    new VoiceStore(server.db).save('local', {
      provider: 'plein/mock',
      voiceId: 'voice-1',
      name: '旁白',
      status: 'ready',
      message: null,
      source: 'clone',
      sampleAssetId: null,
      gender: null,
      age: null,
      credentialId,
      credentialFingerprint: 'fingerprint',
      credentialLabel: '默认',
    })

    const view = (await call<ProviderConfigView>('/api/providers/plein/mock/config')).body
    expect(view.credentials).toHaveLength(1)
    // canceled 的平台任务可能仍在生成；dismissed 不再计入，done 也不计入。
    expect(view.credentials[0]!.usage).toEqual({ tasks: 2, voices: 1 })
  })

  it('按顺序执行密钥组动作，标签与组 id 不合法时返回 400', async () => {
    const { call } = await boot()
    const initial = (
      await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
        secrets: { MOCK_API_KEY: 'personal' },
      })
    ).body
    const personalId = initial.activeCredential!
    const added = await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
      credentials: {
        update: [{ id: personalId, label: '个人', secrets: { MOCK_API_KEY: null } }],
        add: [{ label: '团队', secrets: { MOCK_API_KEY: 'team' } }],
      },
    })
    expect(added.status).toBe(200)
    expect(added.body.credentials).toEqual([
      {
        id: personalId,
        label: '个人',
        secrets: { MOCK_API_KEY: false },
        // 这一组的密钥被清空：没有可显示的掩码
        secretHints: {},
        configured: true,
        usage: { tasks: 0, voices: 0 },
      },
      {
        id: expect.any(String),
        label: '团队',
        secrets: { MOCK_API_KEY: true },
        // 4 位密钥太短：只给固定圆点
        secretHints: { MOCK_API_KEY: '••••••••' },
        configured: true,
        usage: { tasks: 0, voices: 0 },
      },
    ])
    expect(added.body.secrets).toEqual({ MOCK_API_KEY: false })
    const teamId = added.body.credentials[1]!.id
    const activated = await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
      activeCredential: teamId,
    })
    expect(activated.body).toMatchObject({
      activeCredential: teamId,
      secrets: { MOCK_API_KEY: true },
    })
    const removed = await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
      credentials: { remove: [teamId] },
    })
    expect(removed.body.activeCredential).toBe(personalId)

    for (const [body, message] of [
      [{ credentials: { add: [{ label: '个人', secrets: {} }] } }, '不可重复'],
      [{ credentials: { add: [{ label: 'x'.repeat(41), secrets: {} }] } }, '1–40'],
      [{ activeCredential: 'missing' }, '密钥组不存在'],
      [{ credentials: { remove: ['missing'] } }, '密钥组不存在'],
    ] as const) {
      const response = await call<{ message: string }>(
        '/api/providers/plein/mock/config',
        'PUT',
        body,
      )
      expect(response.status).toBe(400)
      expect(response.body.message).toContain(message)
    }
  })

  it('目录里的平台带密钥组数，多组时带当前组标签', async () => {
    const { call } = await boot()
    const provider = async () =>
      (await call<Catalog>('/api/catalog')).body.providers.find((p) => p.id === 'plein/mock')!
    expect((await provider()).credentialCount).toBe(0)

    await call('/api/providers/plein/mock/config', 'PUT', {
      secrets: { MOCK_API_KEY: 'personal' },
    })
    const single = await provider()
    expect(single.credentialCount).toBe(1)
    expect(single.activeCredentialLabel).toBeUndefined()

    await call('/api/providers/plein/mock/config', 'PUT', {
      credentials: { add: [{ label: '团队', secrets: { MOCK_API_KEY: 'team' } }] },
    })
    const multi = await provider()
    expect(multi.credentialCount).toBe(2)
    expect(multi.activeCredentialLabel).toBe('默认')

    const view = (await call<ProviderConfigView>('/api/providers/plein/mock/config')).body
    const teamId = view.credentials.find((c) => c.label === '团队')!.id
    await call('/api/providers/plein/mock/config', 'PUT', { activeCredential: teamId })
    expect((await provider()).activeCredentialLabel).toBe('团队')
  })

  it('同一请求后续动作校验失败时，内存与磁盘都不保留前面的改动', async () => {
    const { server, dataDir, call } = await boot()
    const initial = (
      await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
        secrets: { MOCK_API_KEY: 'personal' },
      })
    ).body
    await call('/api/providers/plein/mock/config', 'PUT', {
      credentials: { add: [{ label: '团队', secrets: { MOCK_API_KEY: 'team' } }] },
    })
    const before = server.plugins.configs.get('plein/mock')
    const file = join(dataDir, 'providers.json')
    const saved = readFileSync(file, 'utf8')
    const response = await call<{ message: string }>('/api/providers/plein/mock/config', 'PUT', {
      credentials: {
        update: [
          { id: initial.activeCredential!, secrets: { MOCK_API_KEY: null } },
          { id: initial.activeCredential!, label: '团队' },
        ],
      },
    })
    expect(response.status).toBe(400)
    expect(response.body.message).toContain('不可重复')
    expect(server.plugins.configs.get('plein/mock')).toEqual(before)
    expect(readFileSync(file, 'utf8')).toBe(saved)
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

    // 读取视图带密钥掩码，同样只给所有者
    const read = await app.request('/api/providers/plein/mock/config')
    expect(read.status).toBe(403)
    expect(((await read.json()) as { message: string }).message).toBe(
      '只有所有者可以查看平台密钥配置',
    )
  })

  it('长密钥掩码只露前三位和末四位，短密钥只露末两位', async () => {
    const { call } = await boot()
    // 只断言结构，不把真实密钥片段写进测试与输出
    const long = (
      await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
        secrets: { MOCK_API_KEY: 'sk-9f3c1b7d5a2e4c6018' },
      })
    ).body
    expect(long.credentials[0]!.secretHints!.MOCK_API_KEY).toMatch(/^sk-••••••[a-z0-9]{4}$/)

    // 8~15 位仍属短密钥：只留末两位
    const medium = (
      await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
        secrets: { MOCK_API_KEY: 'abcdefghijkl' },
      })
    ).body
    expect(medium.credentials[0]!.secretHints!.MOCK_API_KEY).toMatch(/^••••[a-z0-9]{2}$/)

    const short = (
      await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
        secrets: { MOCK_API_KEY: 'shortkey' },
      })
    ).body
    expect(short.credentials[0]!.secretHints!.MOCK_API_KEY).toMatch(/^••••[a-z0-9]{2}$/)

    // 不足 8 位的密钥一个字符都不能露：只给固定圆点
    for (const key of ['a', 'ab', 'ntkatae']) {
      const tiny = (
        await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
          secrets: { MOCK_API_KEY: key },
        })
      ).body
      expect(tiny.credentials[0]!.secretHints!.MOCK_API_KEY).toBe('••••••••')
    }
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

  it('可检查指定密钥组，默认检查当前组，未知组返回 400', async () => {
    const { call } = await boot()
    const initial = (
      await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
        secrets: { MOCK_API_KEY: 'personal' },
      })
    ).body
    const added = await call<ProviderConfigView>('/api/providers/plein/mock/config', 'PUT', {
      credentials: { add: [{ label: '团队', secrets: { MOCK_API_KEY: 'team' } }] },
    })
    const teamId = added.body.credentials[1]!.id
    const seen: Array<string | undefined> = []
    const test = vi.spyOn(mockProvider, 'test').mockImplementation(async (ctx) => {
      seen.push(ctx.secret('MOCK_API_KEY'))
    })
    try {
      expect(
        (await call('/api/providers/plein/mock/test', 'POST', { credential: teamId })).status,
      ).toBe(200)
      expect(seen).toEqual(['team'])
      expect((await call('/api/providers/plein/mock/test', 'POST')).status).toBe(200)
      expect(seen).toEqual(['team', 'personal'])
      const missing = await call<{ message: string }>('/api/providers/plein/mock/test', 'POST', {
        credential: initial.activeCredential + '-missing',
      })
      expect(missing.status).toBe(400)
      expect(missing.body.message).toContain('密钥组不存在')
      expect(test).toHaveBeenCalledTimes(2)
    } finally {
      test.mockRestore()
    }
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

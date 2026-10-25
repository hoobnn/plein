import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { COMPATIBLE_ID, compatiblePlugin, createCompatiblePlugin } from '@plein/providers'
import type { Catalog } from '@plein/protocol'
import { startTestServer, tempDir } from '../testing'
import { PluginHost } from './host'
import { PluginRegistry } from './registry'
import { ProviderConfigStore } from './config-store'
import { scopedFetch } from './sandbox'

const settings = { baseURL: 'https://gateway.example.com/v1', model: 'one' }

describe('内置兼容渠道的宿主边界', () => {
  let assets: Awaited<ReturnType<typeof startTestServer>>['server']['assets']
  beforeAll(async () => {
    assets = (await startTestServer()).server.assets
  })
  function fixture() {
    const configs = new ProviderConfigStore(tempDir())
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('unexpected request')
    })
    const host = new PluginHost(new PluginRegistry(), configs, assets, { fetch })
    host.load([compatiblePlugin], true)
    configs.update(COMPATIBLE_ID, {
      enabled: true,
      settings,
      secrets: { COMPATIBLE_API_KEY: 'secret' },
    })
    return { host, configs, fetch }
  }
  it('配置后目录显示实际模型及显式特性，更换模型移除旧引用', async () => {
    const f = fixture()
    const before = f.host.models('text.chat')[0]!
    expect(before.title).toBe('one')
    f.configs.update(COMPATIBLE_ID, { settings: { ...settings, model: 'two', vision: true } })
    const after = f.host.models('text.chat')[0]!
    expect(after.ref).not.toBe(before.ref)
    expect(after.features).toEqual(['vision'])
    await expect(
      f.host.call(
        'text.chat',
        before.ref,
        { messages: [{ role: 'user', content: 'hi' }] },
        { ownerId: 'local' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('只有内置插件可从设置重建授权，测试不触网', async () => {
    const f = fixture()
    await f.host.testProvider(COMPATIBLE_ID, 'local')
    expect(f.host.registry.plugin(COMPATIBLE_ID)?.manifest.permissions.network).toEqual([
      'gateway.example.com',
    ])
    expect(f.fetch).not.toHaveBeenCalled()
    const registry = new PluginRegistry()
    const host = new PluginHost(registry, f.configs, assets)
    host.load([compatiblePlugin], false)
    expect(host.models('text.chat')).toEqual([])
    expect(registry.plugin(COMPATIBLE_ID)?.manifest.permissions.network).toEqual([])
  })
  it('配置接口保存后同步更新目录，检查结果明确为 configuration', async () => {
    const s = await startTestServer()
    const response = await fetch(`${s.base}/api/providers/plein/compatible/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings, enabled: true, secrets: { COMPATIBLE_API_KEY: 'secret' } }),
    })
    expect(response.status).toBe(200)
    const catalog = (await (await fetch(`${s.base}/api/catalog`)).json()) as Catalog
    expect(catalog.providers.find((p: { id: string }) => p.id === COMPATIBLE_ID)).toMatchObject({
      models: [{ title: 'one', features: [] }],
      configured: true,
    })
    const test = await (
      await fetch(`${s.base}/api/providers/plein/compatible/test`, { method: 'POST' })
    ).json()
    expect(test).toMatchObject({ ok: true, scope: 'configuration', modelAccess: 'unverified' })
  })
  it('在途调用保留原渠道快照，配置变更只影响后续调用', async () => {
    const f = fixture()
    const ref = f.host.models('text.chat')[0]!.ref
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    f.fetch.mockImplementationOnce(async () => {
      started()
      await waiting
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'old channel' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    })
    const pending = f.host.call(
      'text.chat',
      ref,
      { messages: [{ role: 'user', content: 'hi' }] },
      { ownerId: 'local' },
    )
    await ready
    f.configs.update(COMPATIBLE_ID, {
      settings: { ...settings, baseURL: 'https://new.example.com/v1' },
      secrets: { COMPATIBLE_API_KEY: 'new-key' },
    })
    expect(f.host.models('text.chat')[0]!.ref).not.toBe(ref)
    release()
    expect(await pending).toMatchObject({ outputs: [{ type: 'text', text: 'old channel' }] })
    const [request] = f.fetch.mock.calls[0]!
    expect((request as Request).url).toBe('https://gateway.example.com/v1/chat/completions')
    expect((request as Request).headers.get('Authorization')).toBe('Bearer secret')
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('兼容渠道精确 origin', () => {
  const manifest = createCompatiblePlugin(settings).plugin.manifest
  it.each([
    'https://evil.example.com/v1',
    'http://gateway.example.com/v1',
    'https://gateway.example.com:444/v1',
  ])('跨 origin 重定向在发送前阻断 %s', async (location) => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 307, headers: { location } }),
    )
    const scoped = scopedFetch(manifest, fetch, 'https://gateway.example.com')
    await expect(
      scoped('https://gateway.example.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret' },
        body: '{}',
      }),
    ).rejects.toThrow('origin')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('同 origin 重定向保留原有域名与重定向次数检查', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
    expect(
      (
        await scopedFetch(
          manifest,
          fetch,
          'https://gateway.example.com',
        )('https://gateway.example.com/v1')
      ).ok,
    ).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

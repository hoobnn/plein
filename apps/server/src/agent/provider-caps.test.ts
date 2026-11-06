import { describe, expect, it } from 'vite-plus/test'
import { bootServer, createCanvas } from '../testing'
import { serverCapabilities, serverContext, type ToolEnv } from './tools'

describe('平台与模型设置能力', () => {
  it('列出平台只返回启用状态与密钥是否填写，永远不含密钥明文', async () => {
    const { server } = await bootServer()
    const { id } = await createCanvas(server)
    const env: ToolEnv = {
      canvasId: id,
      ownerId: 'local',
      rooms: server.rooms,
      runs: server.runs,
      host: server.plugins,
      assets: server.assets,
      canvasApi: server.canvasApi,
    }
    const invoke = (name: string, args: unknown) =>
      serverCapabilities.invoke(name, serverContext(env), args)
    const list = (await invoke('list_providers', {})) as {
      providers: Array<{ id: string; enabled: boolean; model_count: number }>
      default_models: Record<string, string>
    }
    // 找一个需要密钥的真实平台，写入一个有辨识度的密钥
    const target = [...server.plugins.registry.providers].find(([, p]) => p.def.secrets.length)!
    const [pid, entry] = target
    const secretName = entry.def.secrets[0]!.name
    const secret = 'sk-SUPERSECRET-1234567890-abcdef'
    server.plugins.configs.apply(pid, { secrets: { [secretName]: secret } })
    server.plugins.configs.apply(pid, { enabled: false })

    const detail = (await invoke('list_providers', { id: pid })) as {
      enabled: boolean
      configured: boolean
      secrets_filled: Record<string, boolean>
      models: Array<{ ref: string }>
    }
    const text = JSON.stringify(detail) + JSON.stringify(await invoke('list_providers', {}))
    expect(text).not.toContain(secret)
    expect(text).not.toContain('SUPERSECRET')
    expect(detail.secrets_filled[secretName]).toBe(true)
    expect(detail.enabled).toBe(false)
    expect(list.providers.length).toBeGreaterThan(0)

    expect(await invoke('set_provider_enabled', { id: pid, enabled: true })).toEqual({
      id: pid,
      enabled: true,
    })
    expect(server.plugins.configs.get(pid).enabled).toBe(true)
    await expect(
      invoke('set_provider_enabled', { id: 'nope/none', enabled: true }),
    ).rejects.toThrow('list_providers')
    await expect(invoke('set_provider_enabled', { id: '../x', enabled: true })).rejects.toThrow(
      'vendor/name',
    )
    // 没有写入或读取密钥的入口
    expect(serverCapabilities.get('set_provider_secret')).toBeUndefined()

    // 默认模型：必须是已启用平台上支持该能力的模型
    await expect(
      invoke('set_default_model', { capability: 'image.generate', model: 'nope/none:x' }),
    ).rejects.toThrow('没启用')
    const mock = server.plugins.models('image.generate')[0]!
    await invoke('set_default_model', { capability: 'image.generate', model: mock.ref })
    expect(server.plugins.defaultModels()['image.generate']).toBe(mock.ref)

    const tested = (await invoke('test_provider', { id: 'plein/mock' })) as {
      ok: boolean
      modelAccess: string
    }
    expect(tested.modelAccess).toBe('unverified')
  })
})

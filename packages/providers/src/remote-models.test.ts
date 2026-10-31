/**
 * 各平台 listRemoteModels 的契约测试：请求路径、鉴权头与响应归一化。
 * 传输层用 shared/testing 的假上下文，与其它适配器测试同一套方式。
 */
import { describe, expect, it } from 'vite-plus/test'
import type { ProviderDefinition } from '@plein/plugin-sdk'
import { arkProvider } from './ark'
import { bailianProvider } from './bailian'
import { createCompatiblePlugin, compatibleSettings } from './compatible'
import { minimaxProvider } from './minimax'
import { fakeContext, type Reply } from './testing'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

const list = (items: unknown[]) => ({ object: 'list', data: items })

async function pull(
  provider: ProviderDefinition,
  replies: Reply[],
  settings?: Record<string, unknown>,
) {
  const { ctx, fetch } = fakeContext(provider, replies)
  if (settings) ctx.settings = provider.settings.parse(settings) as typeof ctx.settings
  const models = await provider.listRemoteModels!(ctx)
  const url = String(fetch.mock.calls[0]?.[0])
  const headers = (fetch.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
  return { models, url, auth: headers.Authorization }
}

describe('listRemoteModels', () => {
  it('minimax：按地区取 /v1/models，条目键 model 或 id 都接受', async () => {
    const result = await pull(minimaxProvider, [
      {
        base_resp: { status_code: 0 },
        data: [{ model: 'MiniMax-M3', owned_by: 'minimax', created: 1700000000 }, { id: 'music-3.0' }],
      },
    ])
    expect(result.url).toBe('https://api.minimax.cn/v1/models')
    expect(result.auth).toBe('Bearer test-secret')
    expect(result.models).toEqual([
      { id: 'MiniMax-M3', ownedBy: 'minimax', created: 1700000000 },
      { id: 'music-3.0' },
    ])
  })

  it('minimax：全球地区换域名，鉴权失败时抛错', async () => {
    const { ctx, fetch } = fakeContext(
      minimaxProvider,
      [json({ base_resp: { status_code: 1004 } }, 401)],
    )
    ctx.settings = minimaxProvider.settings.parse({ region: 'global' })
    await expect(minimaxProvider.listRemoteModels!(ctx)).rejects.toThrow(/列表失败/)
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.minimax.io/v1/models')
  })

  it('minimax：响应没有 data 数组时报无效响应', async () => {
    await expect(pull(minimaxProvider, [{ base_resp: { status_code: 0 } }])).rejects.toThrow(/data/)
  })

  it('ark：取按量数据面 /api/v3/models', async () => {
    const result = await pull(arkProvider, [
      list([{ id: 'doubao-seed-2-1-pro-260628', owned_by: 'volcengine' }, { object: 'model' }]),
    ])
    expect(result.url).toBe('https://ark.cn-beijing.volces.com/api/v3/models')
    expect(result.models).toEqual([{ id: 'doubao-seed-2-1-pro-260628', ownedBy: 'volcengine' }])
  })

  it('bailian：走 DashScope 兼容模式列表', async () => {
    const result = await pull(bailianProvider, [list([{ id: 'qwen3.8-max' }])])
    expect(result.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/models')
    expect(result.models.map((m) => m.id)).toEqual(['qwen3.8-max'])
  })

  it('bailian：业务空间模式不支持拉取', async () => {
    await expect(
      pull(bailianProvider, [], { workspaceId: 'ws-1' }),
    ).rejects.toThrow(/业务空间/)
  })

  it('compatible：取渠道 baseURL/models 并归为对话模型', async () => {
    const { providers } = createCompatiblePlugin()
    const def = providers[0]!
    const { ctx, fetch } = fakeContext(def)
    ctx.settings = compatibleSettings.parse({ baseURL: 'https://llm.example.com/v1', model: 'x' })
    fetch.mockResolvedValueOnce(json(list([{ id: 'gpt-x' }])))
    const models = await def.listRemoteModels!(ctx)
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://llm.example.com/v1/models')
    expect(models).toEqual([{ id: 'gpt-x', kind: 'llm' }])
  })

  it('compatible：未配置渠道时报参数错误', async () => {
    const { providers } = createCompatiblePlugin()
    const { ctx } = fakeContext(providers[0]!)
    await expect(providers[0]!.listRemoteModels!(ctx)).rejects.toThrow(/Base URL/)
  })
})

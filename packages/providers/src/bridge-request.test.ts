import type { AdapterContext, ModelDeclaration, PlatformAdapter } from 'modelbay'
import type { ProviderRequest } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { adapterToProvider, stripCallbackUrl } from './bridge'
import { minimaxProvider } from './minimax'
import { fakeContext } from './testing'

const SOURCE = { url: 'https://example.com/docs', checkedAt: '2026-11-05' }
const declaration: ModelDeclaration = {
  canonicalId: 'acme/chat',
  id: 'chat',
  title: 'chat',
  capabilities: ['text.chat'],
  channels: [{ channel: 'main', id: 'chat' }],
  aliases: {},
  lifecycle: { status: 'active', source: SOURCE },
  source: SOURCE,
}

function capturing() {
  const seen: unknown[] = []
  const adapter = {
    id: 'acme/stub',
    title: 'Stub',
    channels: ['main'],
    models: [declaration],
    submit: async (request: unknown, _ctx: AdapterContext) => {
      seen.push(request)
      return { state: 'succeeded', outputs: [] }
    },
  } as unknown as PlatformAdapter
  return { adapter, seen }
}

const request = (input: Record<string, unknown>): ProviderRequest => ({
  capability: 'text.chat',
  model: 'chat',
  input: { messages: [], ...input },
})

describe('桥接统一剥离 callback_url', () => {
  it('extra、options、parameters 与 input 顶层的 callback_url 都不会交给适配器', async () => {
    const { adapter, seen } = capturing()
    const provider = adapterToProvider(adapter, {
      settings: z.object({}),
      secrets: [{ name: 'K', title: 'K', required: true }],
    })
    const { ctx } = fakeContext(provider, [])
    await provider.submit(
      request({
        callback_url: 'https://evil.example/a',
        extra: { callback_url: 'https://evil.example/b', keep: 1 },
        options: { callback_url: 'https://evil.example/c', keep: 2 },
        parameters: { callback_url: 'https://evil.example/d', keep: 3 },
      }),
      ctx,
    )
    expect(seen).toHaveLength(1)
    expect((seen[0] as ProviderRequest).input).toEqual({
      messages: [],
      extra: { keep: 1 },
      options: { keep: 2 },
      parameters: { keep: 3 },
    })
  })

  it('没有回调地址时原样返回同一个请求对象', () => {
    const plain = request({ extra: { keep: 1 } })
    expect(stripCallbackUrl(plain)).toBe(plain)
  })
})

describe('MiniMax 在宿主里的 extra 语义', () => {
  it('对话忽略 extra，不把宿主传入的字段带进请求体', async () => {
    const { ctx, body } = fakeContext(
      minimaxProvider,
      [{ choices: [{ message: { content: '回答' } }] }],
      { secret: 'test-key' },
    )
    await minimaxProvider.submit(
      {
        capability: 'text.chat',
        model: 'MiniMax-M3',
        input: {
          messages: [{ role: 'user', content: 'hi' }],
          extra: { temperature: 0.1, top_p: 0.2, custom_flag: true },
        },
      },
      ctx,
    )
    const sent = body()
    expect(sent).not.toHaveProperty('custom_flag')
    expect(sent).not.toHaveProperty('top_p')
  })

  it('视频不发 callback_url，也不把它当成参数拒绝', async () => {
    const { ctx, body } = fakeContext(minimaxProvider, [{ task_id: 'task-1' }], {
      secret: 'test-key',
    })
    const result = await minimaxProvider.submit(
      {
        capability: 'video.generate',
        model: 'MiniMax-H3',
        input: { prompt: '跳舞', extra: { callback_url: 'https://evil.example/hook' } },
      },
      ctx,
    )
    expect(result).toMatchObject({ state: 'pending', remoteId: 'task-1' })
    expect(JSON.stringify(body())).not.toContain('callback_url')
    expect(JSON.stringify(body())).not.toContain('evil.example')
  })
})

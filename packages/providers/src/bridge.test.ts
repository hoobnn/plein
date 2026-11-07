import { describe, expect, it } from 'vite-plus/test'
import type { ProviderRequest } from '@plein/plugin-sdk'
import { z } from 'zod'
import { adapterModels, adapterToProvider, optionsFromSchema } from './bridge'
import { openaiProvider } from './openai'
import { createOpenAIAdapter, models as openaiModels } from 'modelbay/openai'
import type { AdapterContext, ModelDeclaration, PlatformAdapter } from 'modelbay'
import { fakeContext } from './testing'

describe('adapterToProvider：模型选项与元信息', () => {
  it('JSON Schema 属性上的 title / description / labels 还原到 zod 的 meta', () => {
    const options = optionsFromSchema({
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['a', 'b'],
          title: '模式',
          description: '说明',
          labels: { a: '甲', b: '乙' },
        },
        plain: { type: 'number' },
      },
    })
    expect(options.shape.mode?.meta()).toMatchObject({
      title: '模式',
      description: '说明',
      labels: { a: '甲', b: '乙' },
    })
    expect(options.shape.plain?.meta()).toBeUndefined()
    expect(options.safeParse({ mode: 'a' }).success).toBe(true)
    expect(options.safeParse({ mode: 'c' }).success).toBe(false)
  })

  it('OpenAI 图片模型的参数标题来自 modelbay 声明', () => {
    const spec = openaiProvider.models.find((m) => m.id === 'gpt-image-2.5-sunburst')!
    expect(spec.options?.shape.quality?.meta()?.title).toBe('画质')
    expect(spec.options?.shape.output_format?.meta()?.title).toBe('输出格式')
    expect(spec.options?.safeParse({ quality: 'bad' }).success).toBe(false)
    const chat = openaiProvider.models.find((m) => m.id === 'gpt-6.1-sol')!
    expect(chat.options?.shape.reasoning_effort?.meta()?.title).toBe('思考强度')
  })

  it('对话模型带出声明的上下文窗口与最大输出，内置智能体据此定预算', () => {
    const chat = openaiProvider.models.find((m) => m.id === 'gpt-6.1-sol')!
    expect(chat.contextWindow).toBeGreaterThan(0)
    expect(chat.maxOutputTokens).toBeGreaterThan(0)
    expect(chat.maxOutputTokens!).toBeLessThanOrEqual(chat.contextWindow!)
  })

  it('模型 id 用渠道内 ID，按声明顺序', () => {
    const ids = adapterModels(createOpenAIAdapter(openaiModels), 'openai').map((m) => m.id)
    expect(ids).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6.1-terra',
      'gpt-6-luna',
      'gpt-image-2.6-sunburst',
      'gpt-image-2.6-flare',
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-flare',
    ])
  })

  it('poll: false 时不暴露 poll / cancel；beforeSubmit 抛错不联网', async () => {
    const adapter = createOpenAIAdapter(openaiModels)
    const provider = adapterToProvider(adapter, {
      channel: 'openai',
      settings: z.object({}),
      secrets: [{ name: 'OPENAI_API_KEY', title: 'API Key', required: true }],
      poll: false,
      beforeSubmit() {
        throw new Error('blocked')
      },
    })
    expect(provider.poll).toBeUndefined()
    expect(provider.cancel).toBeUndefined()
    const f = fakeContext(provider)
    await expect(
      provider.submit(
        { capability: 'text.chat', model: 'gpt-6.1-sol', input: { messages: [] } },
        f.ctx,
      ),
    ).rejects.toThrow('blocked')
    expect(f.fetch).not.toHaveBeenCalled()
  })
})

const SOURCE = { url: 'https://example.com/docs', checkedAt: '2026-11-05' }

function declaration(id: string, capabilities: string[], extra: object = {}): ModelDeclaration {
  return {
    canonicalId: `acme/${id}`,
    id,
    title: id,
    capabilities,
    channels: [{ channel: 'main', id }],
    aliases: { official: [], short: [] },
    lifecycle: { status: 'active', source: SOURCE },
    source: SOURCE,
    ...extra,
  } as ModelDeclaration
}

function stubAdapter(models: ModelDeclaration[], seen: Array<string | undefined> = []) {
  const probe = (ctx: AdapterContext) => {
    seen.push(ctx.secret('DECLARED_KEY'), ctx.secret('ALIAS_KEY'))
    return { state: 'succeeded' as const, outputs: [] }
  }
  return {
    id: 'acme/stub',
    title: 'Stub',
    channels: ['main'],
    models,
    submit: async (_request: unknown, ctx: AdapterContext) => probe(ctx),
    poll: async (_id: string, ctx: AdapterContext) => probe(ctx),
    cancel: async (_id: string, ctx: AdapterContext) => void probe(ctx),
    native: async (_op: string, _params: unknown, ctx: AdapterContext) => probe(ctx),
  } as unknown as PlatformAdapter
}

describe('adapterToProvider：通用化处理', () => {
  it('没有 plein 能力的声明（向量化等）不进目录，弃用与渠道级标记来自声明', () => {
    const adapter = stubAdapter([
      declaration('chat', ['text.chat']),
      declaration('embed', ['text.embed']),
      declaration('old', ['text.chat'], {
        lifecycle: { status: 'retired', source: SOURCE },
      }),
      declaration('plan', ['text.chat'], {
        channels: [{ channel: 'main', id: 'plan', agentOnly: true }],
      }),
    ])
    const provider = adapterToProvider(adapter, {
      settings: z.object({}),
      secrets: [{ name: 'DECLARED_KEY', title: 'Key', required: true }],
    })
    expect(provider.models.map((m) => m.id)).toEqual(['chat', 'old', 'plan'])
    expect(provider.models.find((m) => m.id === 'old')?.deprecated).toBe(true)
    expect(provider.models.find((m) => m.id === 'plan')?.agentOnly).toBe(true)
    expect(provider.models.find((m) => m.id === 'chat')?.agentOnly).toBeUndefined()
  })

  it('declaredSecretsOnly 只放行已声明密钥，未声明的名字返回 undefined 而不是抛错', async () => {
    const seen: Array<string | undefined> = []
    const adapter = stubAdapter([declaration('chat', ['text.chat'])], seen)
    const make = (declaredSecretsOnly: boolean) =>
      adapterToProvider(adapter, {
        settings: z.object({}),
        secrets: [{ name: 'DECLARED_KEY', title: 'Key', required: true }],
        declaredSecretsOnly,
        async test(ctx) {
          seen.push(ctx.secret('ALIAS_KEY'))
        },
      })
    const provider = make(true)
    const f = fakeContext(provider, [], {
      secret: { DECLARED_KEY: 'k', ALIAS_KEY: 'alias' },
    })
    const request: ProviderRequest = {
      capability: 'text.chat',
      model: 'chat',
      input: { messages: [] },
    }
    await provider.submit(request, f.ctx)
    await provider.poll!('r', f.ctx)
    await provider.cancel!('r', f.ctx)
    await provider.test!(f.ctx)
    expect(seen).toEqual(['k', undefined, 'k', undefined, 'k', undefined, undefined])

    seen.length = 0
    const open = make(false)
    await open.submit(request, fakeContext(open, [], { secret: { ALIAS_KEY: 'alias' } }).ctx)
    expect(seen).toEqual([undefined, 'alias'])
  })
})

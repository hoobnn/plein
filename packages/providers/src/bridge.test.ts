import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { adapterModels, adapterToProvider, optionsFromSchema } from './bridge'
import { openaiProvider } from './openai'
import { createOpenAIAdapter, models as openaiModels } from '@modelbay/openai'
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

  it('模型 id 用渠道内 ID，按声明顺序', () => {
    const ids = adapterModels(createOpenAIAdapter(openaiModels), 'openai').map((m) => m.id)
    expect(ids).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6.1-terra',
      'gpt-6-luna',
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

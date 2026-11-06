import { llmNode } from '@plein/nodes'
import type { ExecutorContext, ModelSpec } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { coreServerPlugin } from './core'

const executor = coreServerPlugin.executors.find((e) => e.node.type === 'plein/llm')!

const spec = (features?: ModelSpec['features']): ModelSpec & { ref: string } => ({
  id: 'chat',
  title: 'Mock 对话',
  capabilities: ['text.chat'],
  ...(features ? { features } : {}),
  ref: 'mock:chat',
})

const run = async (models: Array<ModelSpec & { ref: string }>, withImage: boolean) => {
  const call = vi.fn(async () => ({
    assets: [],
    outputs: [{ type: 'text' as const, text: '回复' }],
  }))
  await executor.run({
    params: llmNode.params.parse({ model: 'mock:chat', prompt: '看图说话' }),
    inputs: withImage
      ? { images: [{ type: 'image', assetId: 'a'.repeat(64), kind: 'image' }] }
      : {},
    providers: { call, models: () => models },
  } as unknown as ExecutorContext)
  return call
}

describe('对话模型看图', () => {
  it('模型不支持看图却连了图：报错说清原因，不把图悄悄送进去', async () => {
    await expect(run([spec()], true)).rejects.toThrow(
      '当前对话模型不支持看图，请换支持图片的模型或断开图片输入',
    )
  })

  it('模型支持看图：图照常送入模型', async () => {
    const call = await run([spec(['vision'])], true)
    expect(call).toHaveBeenCalled()
  })

  it('模型不支持看图但没连图：正常调用', async () => {
    const call = await run([spec()], false)
    expect(call).toHaveBeenCalled()
  })
})

describe('对话模型专属参数', () => {
  const callWith = async (params: Record<string, unknown>) => {
    const call = vi.fn(async () => ({
      assets: [],
      outputs: [{ type: 'text' as const, text: '回复' }],
    }))
    await executor.run({
      params: llmNode.params.parse({ model: 'mock:chat', prompt: '你好', ...params }),
      inputs: {},
      providers: { call, models: () => [spec()] },
    } as unknown as ExecutorContext)
    return (call.mock.calls[0] as unknown as [string, string, { extra?: unknown }])[2]
  }

  it('只把所选模型那份专属参数作为 extra 交给平台', async () => {
    const input = await callWith({
      options: {
        'mock:chat': { reasoning_effort: 'high', web_search: {} },
        'mock:other': { verbosity: 'low' },
      },
    })
    expect(input.extra).toEqual({ reasoning_effort: 'high', web_search: {} })
  })

  it('没设专属参数时 extra 为空对象', async () => {
    expect((await callWith({})).extra).toEqual({})
  })
})

import { imageNode } from '@plein/nodes'
import type { ExecutorContext, ModelSpec } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { coreServerPlugin } from './core'

const executor = coreServerPlugin.executors.find((e) => e.node.type === 'plein/image')!

const run = async (limits: ModelSpec['limits'], seed: number | undefined) => {
  const call = vi.fn(async () => ({ assets: [], outputs: [] }))
  const spec: ModelSpec & { ref: string } = {
    id: 'img',
    title: 'Mock 图片',
    capabilities: ['image.generate'],
    ...(limits ? { limits } : {}),
    ref: 'mock:img',
  }
  await executor.run({
    params: imageNode.params.parse({ model: 'mock:img', prompt: '海边', seed }),
    inputs: {},
    providers: { call, models: () => [spec] },
    progress: () => {},
  } as unknown as ExecutorContext)
  return (call.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2]
}

describe('图片种子', () => {
  it('模型声明了种子范围：种子传给平台', async () => {
    const input = await run({ seed: { min: 0, max: 100 } }, 42)
    expect(input.seed).toBe(42)
  })

  it('留空不传；模型不支持种子时残留的值也不传', async () => {
    expect('seed' in (await run({ seed: { min: 0, max: 100 } }, undefined))).toBe(false)
    expect('seed' in (await run({ seed: false }, 42))).toBe(false)
  })

  it('种子超出声明范围：提交前报错，不请求平台', async () => {
    await expect(run({ seed: { min: 0, max: 100 } }, 500)).rejects.toThrow('种子')
  })
})

import { videoNode } from '@plein/nodes'
import type { ExecutorContext, ProviderCallResult } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { coreServerPlugin } from './core'

const video = { assetId: 'video-one', kind: 'video' as const, mime: 'video/webm' }
const tail = { assetId: 'tail-one', kind: 'image' as const, mime: 'image/png' }

/** 一成一败：第一次成功，第二次失败 */
const oneOkOneFail = () =>
  vi
    .fn<() => Promise<ProviderCallResult>>()
    .mockResolvedValueOnce({ assets: [video], outputs: [] })
    .mockRejectedValueOnce(new Error('平台限流'))

const videoExecutor = coreServerPlugin.executors.find((e) => e.node.type === 'plein/video')!

const ctxOf = (
  call: ReturnType<typeof vi.fn>,
  params: Record<string, unknown> = {},
  progress = vi.fn(),
) =>
  ({
    params: videoNode.params.parse({ model: 'minimax/api:MiniMax-H3', prompt: '推门', ...params }),
    inputs: {},
    progress,
    providers: {
      call,
      models: () => [],
    },
  }) as unknown as ExecutorContext

describe('视频多条生成', () => {
  it('一条失败不丢掉已经出片的另一条，返回成功的那条并报告失败数', async () => {
    const call = oneOkOneFail()
    const progress = vi.fn()
    const out = await videoExecutor.run(ctxOf(call, { count: 2 }, progress))
    expect(call).toHaveBeenCalledTimes(2)
    expect(out.video).toEqual([{ type: 'video', ...video, outputGroup: '0' }])
    expect(progress).toHaveBeenCalledWith(0, '共 2 条，1 条失败：平台限流')
  })

  it('两条都失败：按第一条失败的原因报错，不返回结果', async () => {
    const call = vi
      .fn<() => Promise<ProviderCallResult>>()
      .mockRejectedValueOnce(new Error('平台限流'))
      .mockRejectedValueOnce(new Error('余额不足'))
    await expect(videoExecutor.run(ctxOf(call, { count: 2 }))).rejects.toThrow('平台限流')
  })

  it('输出组序号按原始条序，不按成功的条数重新编号', async () => {
    const call = vi
      .fn<() => Promise<ProviderCallResult>>()
      .mockRejectedValueOnce(new Error('平台限流'))
      .mockResolvedValueOnce({ assets: [video, tail], outputs: [] })
    const out = await videoExecutor.run(ctxOf(call, { count: 2 }))
    expect(out.video).toEqual([{ type: 'video', ...video, outputGroup: '1' }])
    expect(out.lastFrame).toEqual([{ type: 'image', ...tail, outputGroup: '1' }])
  })
})

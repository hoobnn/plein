import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { defineProvider, describeProvider } from './provider'

describe('模型提示词指南描述', () => {
  it('带专属参数和不带专属参数的模型都保留指南版本与正文，不执行平台调用', () => {
    const guide = { version: 'guide-1', text: '可核对的模型创作参考，不授予工具执行权。' }
    let calls = 0
    const provider = defineProvider({
      id: 'test/p',
      title: '测试',
      settings: z.object({}),
      secrets: [],
      models: [
        { id: 'a', title: 'A', capabilities: ['video.generate'], promptGuide: guide },
        {
          id: 'b',
          title: 'B',
          capabilities: ['image.generate'],
          promptGuide: guide,
          options: z.object({ fixed: z.boolean().optional() }),
        },
      ],
      submit: async () => {
        calls++
        return { state: 'pending', remoteId: 'never' }
      },
    })
    const descriptor = JSON.parse(JSON.stringify(describeProvider(provider, 'test/plugin')))
    expect(descriptor.models.map((m: { promptGuide: unknown }) => m.promptGuide)).toEqual([
      guide,
      guide,
    ])
    expect(descriptor.models[1].optionsSchema.properties.fixed.type).toBe('boolean')
    expect(calls).toBe(0)
  })
})

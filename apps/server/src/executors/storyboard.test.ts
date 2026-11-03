import { storyboardNode } from '@plein/nodes'
import type { ExecutorContext } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { coreServerPlugin } from './core'

const executor = coreServerPlugin.executors.find((e) => e.node.type === 'plein/storyboard')!

const run = async (visualStyle?: string) => {
  const call = vi.fn(
    async (
      _capability: string,
      _model: string,
      _request: { messages: Array<{ role: string; content: string }> },
    ) => ({
      assets: [],
      outputs: [{ type: 'json' as const, value: { shots: [{ no: 1, description: '一个镜头' }] } }],
    }),
  )
  await executor.run({
    params: storyboardNode.params.parse({
      model: 'mock:chat',
      shotCount: 3,
      ...(visualStyle === undefined ? {} : { visualStyle }),
    }),
    inputs: { script: [{ type: 'text', text: '剧本正文' }] },
    providers: { call },
  } as unknown as ExecutorContext)
  const messages = call.mock.calls[0]![2].messages
  return messages.find((m) => m.role === 'user')!.content
}

describe('分镜生成带全局视觉风格', () => {
  it('风格非空时在补充要求之后写明风格，并要求画面与运动提示词都体现它', async () => {
    const user = await run('赛博朋克霓虹')
    expect(user).toContain(
      '全局视觉风格：赛博朋克霓虹。每个镜头的画面提示词和运动提示词都要体现这一风格。',
    )
    const style = user.indexOf('全局视觉风格：')
    const script = user.indexOf('<剧本>')
    expect(style).toBeGreaterThan(-1)
    expect(style).toBeLessThan(script)
  })

  it('风格为空或没填时不加这段', async () => {
    for (const style of ['', '   ', undefined]) {
      const user = await run(style)
      expect(user).not.toContain('全局视觉风格')
    }
  })
})

import { describe, expect, it, vi } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { compatibleSettings, createCompatiblePlugin } from './index'

const provider = createCompatiblePlugin().providers[0]!

describe('兼容渠道拉取模型候选', () => {
  it('Base URL 为空时先提示填写，不联网', async () => {
    const { ctx, fetch } = fakeContext(provider, [])
    ctx.settings = compatibleSettings.parse({})
    await expect(provider.listRemoteModels?.(ctx)).rejects.toMatchObject({
      code: 'invalid_input',
      message: '请先填写渠道 Base URL，再拉取模型候选',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('只放行清单里声明的密钥名，适配器探测的别名按未设置处理', async () => {
    const { ctx } = fakeContext(provider, [Response.json({ data: [{ id: 'm1' }] })])
    ctx.settings = compatibleSettings.parse({ baseURL: 'https://gateway.example.com/v1' })
    const asked = vi.fn((name: string) =>
      name === 'COMPATIBLE_API_KEY' ? 'declared-key' : 'alias-key',
    )
    ctx.secret = asked
    await provider.listRemoteModels?.(ctx)
    const names = asked.mock.calls.map(([name]) => name)
    expect(names).toContain('COMPATIBLE_API_KEY')
    expect(names.every((name) => name === 'COMPATIBLE_API_KEY')).toBe(true)
    const headers = (ctx.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].headers as Record<
      string,
      string
    >
    expect(JSON.stringify(headers)).toContain('declared-key')
    expect(JSON.stringify(headers)).not.toContain('alias-key')
  })
})

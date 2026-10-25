import { describe, expect, it } from 'vite-plus/test'
import { fakeContext, requestBody, sse, aborted } from '../testing'
import { compatibleBaseURL, compatibleSettings, createCompatiblePlugin } from './index'
import type { CapabilityInput } from '@plein/plugin-sdk'

const config = { baseURL: 'https://gateway.example.com/v1', model: 'custom-chat' }
const frame = (text = 'hello') =>
  sse(
    `data: ${JSON.stringify({ id: 'c1', model: 'custom-chat', choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  )
function fixture(settings: Record<string, unknown> = {}, reply: Response | Error = frame()) {
  const plugin = createCompatiblePlugin({ ...config, ...settings })
  const provider = plugin.providers[0]!
  const f = fakeContext(provider, [reply])
  f.ctx.settings = compatibleSettings.parse({ ...config, ...settings })
  const run = (input: Partial<CapabilityInput<'text.chat'>> = {}) =>
    provider.submit(
      {
        capability: 'text.chat',
        model: provider.models[0]!.id,
        input: { messages: [{ role: 'user', content: 'hi' }], ...input },
      },
      f.ctx,
    )
  return { ...f, run, provider, plugin }
}

describe('兼容对话渠道', () => {
  it('渠道回显去掉空白后的有效密钥时也脱敏', async () => {
    const f = fixture(
      {},
      Response.json({ error: { message: 'invalid key padded-key' } }, { status: 401 }),
    )
    f.ctx.secret = () => ' padded-key '
    await expect(f.run()).rejects.toMatchObject({ code: 'auth', message: 'invalid key [redacted]' })
  })
  it('未配置时不提供虚假模型，只申请自身密钥和精确域名', () => {
    expect(createCompatiblePlugin().providers[0]!.models).toEqual([])
    const { plugin, provider } = fixture()
    expect(plugin.plugin.manifest.permissions.network).toEqual(['gateway.example.com'])
    expect(provider.testScope).toBe('configuration')
    expect(provider.models[0]!.features).toEqual([])
  })
  it('配置检查不联网，不宣称远端鉴权和能力通过', async () => {
    const f = fixture()
    await f.provider.test!(f.ctx)
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.ctx.log).toHaveBeenCalledWith(expect.stringContaining('未验证网络'))
  })
  it('按完整协议前缀提交真实模型，用量和文本走共用实现', async () => {
    const f = fixture()
    expect(await f.run()).toMatchObject({
      state: 'succeeded',
      outputs: [{ type: 'text', text: 'hello' }],
    })
    expect(f.fetch.mock.calls[0]?.[0]).toBe('https://gateway.example.com/v1/chat/completions')
    expect(requestBody(f.fetch)).toMatchObject({ model: 'custom-chat', stream: true })
  })
  it.each(['vision', 'tools', 'structured', 'model', 'baseURL'] as const)(
    '%s 更改会生成新的模型身份',
    (field) => {
      const changes = {
        vision: true,
        tools: true,
        structured: 'json_schema',
        model: 'other',
        baseURL: 'https://other.example.com/v1',
      }
      expect(fixture({ [field]: changes[field] }).provider.models[0]!.id).not.toBe(
        fixture().provider.models[0]!.id,
      )
    },
  )
  it('尾部斜杠规范化，不无故改变模型身份', () => {
    expect(fixture({ baseURL: `${config.baseURL}/` }).provider.models[0]!.id).toBe(
      fixture().provider.models[0]!.id,
    )
  })
  it('旧模型引用不能按新配置提交', async () => {
    const f = fixture()
    f.ctx.settings = compatibleSettings.parse({ ...config, model: 'other' })
    await expect(f.run()).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([
    {
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'image' as const, image: { assetId: 'x', kind: 'image' as const } }],
        },
      ],
    },
    { tools: [{ name: 'echo', description: '', parameters: { type: 'object' } }] },
    { messages: [{ role: 'tool' as const, content: 'done', toolCallId: 'x' }] },
    { jsonSchema: { type: 'object' } },
  ])('未声明的能力在发送前阻断', async (input) => {
    const f = fixture()
    await expect(f.run(input)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('显式视觉能力读取本地图片，extra 不能覆盖模型和消息', async () => {
    const f = fixture({ vision: true })
    await f.run({
      messages: [
        { role: 'user', content: [{ type: 'image', image: { assetId: 'x', kind: 'image' } }] },
      ],
      extra: { model: 'evil', messages: [], stream: false },
    })
    expect(requestBody(f.fetch)).toMatchObject({
      model: 'custom-chat',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }],
        },
      ],
    })
  })
  it('流中断保留提交未知，不自动重试', async () => {
    const f = fixture({}, sse('data: {"choices":[{"delta":{"content":"part"}}]}\n\n'))
    await expect(f.run()).rejects.toMatchObject({ code: 'unknown', outcome: 'unknown' })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    [401, 'auth'],
    [429, 'rate_limit'],
    [503, 'unavailable'],
  ] as const)('HTTP %i 归类并脱敏', async (status, code) => {
    const f = fixture(
      {},
      Response.json({ error: { message: 'test-secret Bearer sk-private' } }, { status }),
    )
    await expect(f.run()).rejects.toMatchObject({
      code,
      retryable: false,
      message: '[redacted] Bearer [redacted]',
    })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it('发出前取消不提交', async () => {
    const f = fixture()
    f.ctx.signal = aborted()
    await expect(f.run()).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([
    'https://user:pass@api.example.com/v1',
    'http://api.example.com',
    'https://api.example.com/v1?key=x',
    'file:///tmp/test',
    'https://127.0.0.1/v1',
  ])('拒绝不合法的渠道地址 %s', (url) => {
    expect(() => compatibleBaseURL(url)).toThrow()
    expect(compatibleSettings.safeParse({ ...config, baseURL: url }).success).toBe(false)
  })
  it('允许显式 localhost HTTP 端口', () => {
    expect(compatibleBaseURL('http://localhost:11434/v1').origin).toBe('http://localhost:11434')
  })
})

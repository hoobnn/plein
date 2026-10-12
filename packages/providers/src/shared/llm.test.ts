import { type CapabilityInput, ProviderError } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import { requestBody, sse } from '../testing'
import { type ChatOptions, chatCompletion, requireSseDone } from './llm'

const cut = () => new ProviderError('unknown', '回答不完整')

function frames(content: string, finish: string) {
  return sse(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
  )
}

function chat(reply: Response | Error, input: Partial<CapabilityInput<'text.chat'>> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (reply instanceof Error) throw reply
    return reply
  })
  const opts: ChatOptions = {
    ctx: { signal: new AbortController().signal },
    label: '测试',
    baseURL: 'https://llm.test/v1',
    fetch,
    model: 'm',
    input: { messages: [{ role: 'user', content: 'hi' }], ...input },
    image: async () => 'data:x',
    structured: 'json_schema',
    streamError: () => new ProviderError('unknown', '流错误'),
  }
  return { run: () => chatCompletion(opts), fetch }
}

describe('SSE 必须以 [DONE] 结束', () => {
  it('缺少 [DONE] 时读到结尾报适配器给的错误', async () => {
    const res = requireSseDone(sse('data: {"a":1}\n\n'), cut)
    await expect(res.text()).rejects.toThrow('回答不完整')
  })

  it('收到 [DONE] 时原样读完', async () => {
    const text = 'data: {"a":1}\n\ndata: [DONE]\n\n'
    expect(await requireSseDone(sse(text), cut).text()).toBe(text)
  })

  it('非 SSE 响应原样放过', () => {
    const res = Response.json({ a: 1 })
    expect(requireSseDone(res, cut)).toBe(res)
  })
})

describe('OpenAI 兼容对话', () => {
  it('平台内容过滤归为 content_policy', async () => {
    const { run } = chat(frames('部分', 'content_filter'))
    await expect(run()).rejects.toMatchObject({ code: 'content_policy' })
  })

  it('结构化输出被 token 上限截断时报 unknown，不当成功', async () => {
    const { run } = chat(frames('{"a":', 'length'), { jsonSchema: { type: 'object' } })
    await expect(run()).rejects.toMatchObject({
      code: 'unknown',
      message: '结构化输出被 token 上限截断',
    })
  })

  it('extra 不能覆盖模型、消息、流式开关和工具，其余字段照发', async () => {
    const { run, fetch } = chat(frames('好', 'stop'), {
      extra: { model: 'evil', messages: [], stream: false, tools: [], top_p: 0.5 },
    })
    expect(await run()).toMatchObject({ outputs: [{ type: 'text', text: '好' }] })
    const body = requestBody(fetch)
    expect(body).toMatchObject({
      model: 'm',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.5,
    })
    expect(body).not.toHaveProperty('tools')
  })

  it('适配器 fetch 抛出的 ProviderError 原样传出，不被 AI SDK 包装', async () => {
    const error = new ProviderError('quota', '欠费')
    await expect(chat(error).run()).rejects.toBe(error)
  })
})

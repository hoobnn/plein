import { ProviderError } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  chatMessages,
  imageDataUrl,
  redact,
  retryableFor,
  send,
  transportError,
  withRetry,
} from './http'
import { aborted } from '../testing'

const messages = { cancelled: '已取消', network: '网络失败', timeout: '超时' }
const live = () => new AbortController().signal

describe('公共请求层的重试规则', () => {
  it('提交生成的 POST 无论什么错误都不可重试', () => {
    for (const code of ['rate_limit', 'unavailable', 'timeout', 'unknown'] as const)
      expect(retryableFor('POST', code)).toBe(false)
  })

  it('查询 GET 限流、不可用和超时可重试，其余不可重试', () => {
    expect(retryableFor('GET', 'rate_limit')).toBe(true)
    expect(retryableFor('GET', 'unavailable')).toBe(true)
    expect(retryableFor('GET', 'timeout')).toBe(true)
    expect(retryableFor('GET', 'auth')).toBe(false)
    expect(retryableFor('GET', 'invalid_input')).toBe(false)
    expect(retryableFor('DELETE', 'unavailable')).toBe(false)
  })

  it('withRetry 按方法覆盖平台错误的默认可重试标记', () => {
    const error = new ProviderError('unavailable', 'HTTP 503')
    expect(error.retryable).toBe(true)
    expect(withRetry(error, 'POST')).toMatchObject({ code: 'unavailable', retryable: false })
    expect(withRetry(error, 'GET')).toMatchObject({ code: 'unavailable', retryable: true })
  })

  it('网络失败：POST 提交结果未知不可重试，GET 可重试', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed')
    })
    const ctx = { fetch, signal: live() }
    await expect(
      send(ctx, 'https://x.test', { method: 'POST', body: '{}' }, messages),
    ).rejects.toMatchObject({ code: 'unavailable', message: '网络失败', retryable: false })
    await expect(send(ctx, 'https://x.test', { method: 'GET' }, messages)).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    })
  })

  it('请求超时：POST 不可重试，GET 可重试；未给超时文案时按网络失败处理', () => {
    const cause = new DOMException('timed out', 'TimeoutError')
    const ctx = { signal: live() }
    expect(transportError(ctx, 'POST', cause, messages)).toMatchObject({
      code: 'timeout',
      retryable: false,
    })
    expect(transportError(ctx, 'GET', cause, messages)).toMatchObject({
      code: 'timeout',
      retryable: true,
    })
    expect(
      transportError(ctx, 'GET', cause, { cancelled: '已取消', network: '网络失败' }),
    ).toMatchObject({ code: 'unavailable', retryable: true })
  })

  it('中止归为 cancelled 且不可重试，GET 也一样', () => {
    const ctx = { signal: aborted() }
    for (const method of ['GET', 'POST'] as const)
      expect(transportError(ctx, method, new Error('aborted'), messages)).toMatchObject({
        code: 'cancelled',
        message: '已取消',
        retryable: false,
      })
  })

  it('宿主超时中止 signal 时归为不可重试的 timeout', () => {
    const ctx = { signal: aborted(new DOMException('timed out', 'TimeoutError')) }
    expect(transportError(ctx, 'GET', new Error('aborted'), messages)).toMatchObject({
      code: 'timeout',
      retryable: false,
    })
  })

  it('把 signal 传给 fetch，HTTP 错误状态原样返回给调用方解析', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('bad', { status: 502 }))
    const signal = live()
    const res = await send({ fetch, signal }, 'https://x.test', { method: 'GET' }, messages)
    expect(res.status).toBe(502)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', signal })
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('body')
  })
})

describe('公共请求层的脱敏与素材', () => {
  it('长密钥先替换，可选清掉 Bearer 与 sk- 令牌', () => {
    expect(redact('abc abcdef', ['abc', 'abcdef', undefined, ''])).toBe('[redacted] [redacted]')
    expect(redact('Bearer xyz sk-123 ok', [], { mask: '[REDACTED]', tokens: true })).toBe(
      'Bearer [REDACTED] [REDACTED] ok',
    )
  })

  it('参考图编码成小写 MIME 的 data URL，并检查类型、格式和大小', async () => {
    const rule = {
      notImage: '不是图片',
      accept: (mime: string) => mime === 'image/png',
      badMime: '格式不对',
      maxBytes: 3,
      tooLarge: '太大或为空',
    }
    const file = (data: number[], mime = 'IMAGE/PNG') => ({
      files: { read: async () => ({ data: new Uint8Array(data), mime }) },
    })
    const ref = { assetId: 'a', kind: 'image' as const }
    expect(await imageDataUrl(file([1, 2, 3]), ref, rule)).toBe('data:image/png;base64,AQID')
    await expect(
      imageDataUrl(file([1]), { assetId: 'a', kind: 'video' }, rule),
    ).rejects.toMatchObject({ code: 'invalid_input', message: '不是图片' })
    await expect(imageDataUrl(file([1], 'image/gif'), ref, rule)).rejects.toThrow('格式不对')
    await expect(imageDataUrl(file([1, 2, 3, 4]), ref, rule)).rejects.toThrow('太大或为空')
    await expect(imageDataUrl(file([]), ref, rule)).rejects.toThrow('太大或为空')
    expect(await imageDataUrl(file([]), ref, { ...rule, allowEmpty: true })).toBe(
      'data:image/png;base64,',
    )
  })

  it('对话消息的图片换成 image_url，文本原样保留', async () => {
    const ref = { assetId: 'a', kind: 'image' as const }
    expect(
      await chatMessages(
        [
          { role: 'system', content: 'sys' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hi' },
              { type: 'image', image: ref },
            ],
          },
        ],
        async () => 'data:x',
      ),
    ).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'data:x' } },
        ],
      },
    ])
  })
})

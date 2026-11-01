import { gzipSync, gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { arkPlanProvider } from './index'
import { asrPacket } from './plan-speech'

// 服务端格式独立构造：终包带负序号，JSON gzip 压缩。
function reply(value: unknown, final = false) {
  const payload = gzipSync(Buffer.from(JSON.stringify(value)))
  const header = Buffer.from([0x11, final ? 0x93 : 0x91, 0x11, 0, 0, 0, 0, 1, 0, 0, 0, 0])
  header.writeInt32BE(final ? -2 : 1, 4)
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, payload])
}

const request = {
  capability: 'audio.transcribe' as const,
  model: 'doubao-seed-asr-2.0',
  input: { audio: { assetId: 'a', kind: 'audio' as const } },
}

it('ASR 使用套餐 WebSocket、二进制末包，分句毫秒转为秒', async () => {
  const { ctx, fetch } = fakeContext(arkPlanProvider, [], { mime: 'audio/mpeg' })
  const send = vi.fn(),
    close = vi.fn()
  const receive = vi
    .fn()
    .mockResolvedValueOnce(reply({}))
    .mockResolvedValueOnce(
      reply(
        {
          result: { text: '你好', utterances: [{ text: '你好', start_time: 100, end_time: 900 }] },
        },
        true,
      ),
    )
  ctx.socket = vi.fn(async () => ({ send, receive, close }))
  const result = await arkPlanProvider.submit(request, ctx)
  expect(ctx.socket).toHaveBeenCalledWith(
    'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream',
    expect.objectContaining({
      'X-Api-Key': 'test-secret',
      'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
    }),
  )
  const initial = Buffer.from(send.mock.calls[0]![0] as Uint8Array)
  expect(JSON.parse(gunzipSync(initial.subarray(12)).toString())).toMatchObject({
    audio: { format: 'mp3' },
    request: { show_utterances: true },
  })
  const final = Buffer.from(send.mock.calls[1]![0] as Uint8Array)
  expect(final[1]).toBe(0x23)
  expect(final.readInt32BE(4)).toBe(-2)
  expect(gunzipSync(final.subarray(12))).toEqual(Buffer.from([1, 2, 3]))
  if (result.state !== 'succeeded') throw new Error('expected success')
  expect(result.outputs).toEqual([
    { type: 'text', text: '你好' },
    { type: 'json', value: { segments: [{ text: '你好', start: 0.1, end: 0.9 }] } },
  ])
  expect(close).toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('断流不能当作成功，关闭连接且不自动重试', async () => {
  const { ctx } = fakeContext(arkPlanProvider, [], { mime: 'audio/wav' })
  const close = vi.fn()
  ctx.socket = vi.fn(async () => ({
    send: vi.fn(),
    close,
    receive: vi.fn().mockResolvedValueOnce(reply({})).mockRejectedValueOnce(new Error('closed')),
  }))
  await expect(arkPlanProvider.submit(request, ctx)).rejects.toMatchObject({
    code: 'unavailable',
    outcome: 'unknown',
    retryable: false,
  })
  expect(close).toHaveBeenCalledOnce()
  expect(ctx.socket).toHaveBeenCalledOnce()
})

it('不完整终包不能当作成功', () => {
  const data = reply({ result: { text: 'hi' } }, true)
  expect(() => asrPacket(data.subarray(0, data.length - 1))).toThrow('不完整')
})

describe('套餐语音权限', () => {
  it('不将复刻音色提交到套餐 TTS', async () => {
    const { ctx, fetch } = fakeContext(arkPlanProvider)
    await expect(
      arkPlanProvider.submit(
        {
          capability: 'audio.speech',
          model: 'doubao-seed-tts-2.0',
          input: { text: 'hi', voice: 'S_123456' },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('缺少 socket 的宿主明确报错', async () => {
    const { ctx } = fakeContext(arkPlanProvider)
    await expect(arkPlanProvider.submit(request, ctx)).rejects.toThrow('升级 Plein')
  })
})

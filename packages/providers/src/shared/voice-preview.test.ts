import { describe, expect, it, vi } from 'vite-plus/test'
import { downloadVoicePreview } from './voice-preview'
import { sineWav } from '../mock/media'

describe('音色试听下载', () => {
  it('识别对象存储 application/octet-stream 中的 WAV，而非保存为错误 MIME', async () => {
    const bytes = sineWav(0.01)
    const ctx = {
      fetch: vi.fn(
        async () =>
          new Response(Buffer.from(bytes), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      ),
      signal: new AbortController().signal,
    }
    expect(await downloadVoicePreview('https://example.com/preview', ctx)).toEqual({
      data: bytes,
      mime: 'audio/wav',
    })
  })
  it('HTML 错误页不能作为音频保存；超过上限时停止读取', async () => {
    const cancel = vi.fn()
    const ctx = {
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('<html>Error</html>'))
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(20 * 1024 * 1024 + 1))
              },
              cancel,
            }),
          ),
        ),
      signal: new AbortController().signal,
    }
    await expect(downloadVoicePreview('https://example.com/preview', ctx)).rejects.toThrow(
      '有效音频',
    )
    await expect(downloadVoicePreview('https://example.com/preview', ctx)).rejects.toThrow('过大')
    expect(cancel).toHaveBeenCalledOnce()
  })
})

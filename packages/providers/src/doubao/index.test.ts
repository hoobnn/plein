import type { ProviderContext } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import { doubaoPlugin, doubaoProvider } from '.'

function context(
  response = new Response(''),
  values: Record<string, string> = { VOLC_SPEECH_API_KEY: 'test-key' },
) {
  return {
    settings: doubaoProvider.settings.parse({}),
    secret: (name: string) => values[name],
    fetch: vi.fn(async () => response) as unknown as ProviderContext['fetch'],
    signal: new AbortController().signal,
    log: vi.fn(),
    files: { read: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mime: 'audio/wav' })) },
  }
}

describe('Doubao Speech HTTP contracts', () => {
  it('accepts null audio in sentence metadata and the terminal packet', async () => {
    const ctx = context(
      new Response(
        '{"code":0,"data":"AQID"}\n{"code":0,"data":null,"sentence":{}}\n{"code":20000000,"data":null}',
      ),
    )
    expect(
      await doubaoProvider.submit(
        { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'fixture' } },
        ctx,
      ),
    ).toMatchObject({ state: 'succeeded', outputs: [{ data: new Uint8Array([1, 2, 3]) }] })
  })
  it('assembles streamed PCM into a playable mono 16-bit WAV with one container', async () => {
    const ctx = context(new Response('{"code":0,"data":"AAD/"}\n{"code":20000000,"data":"fwCA"}'))
    ctx.settings.format = 'wav'
    ctx.settings.sampleRate = '48000'
    const result = await doubaoProvider.submit(
      { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'fixture' } },
      ctx,
    )
    expect(result.state).toBe('succeeded')
    if (result.state !== 'succeeded') throw new Error('expected audio')
    const output = result.outputs[0]!
    if (output.type !== 'file' || !output.data) throw new Error('expected file')
    const wav = Buffer.from(output.data)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(48000)
    expect(wav.readUInt32LE(28)).toBe(96000)
    expect(wav.readUInt16LE(32)).toBe(2)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.toString('ascii', 36, 40)).toBe('data')
    expect(wav.readUInt32LE(40)).toBe(6)
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([
      0, 32767, -32768,
    ])
    expect(output).toMatchObject({ name: 'doubao.wav', mime: 'audio/wav' })
    const body = JSON.parse(String(vi.mocked(ctx.fetch).mock.calls[0]![1]!.body))
    expect(body.req_params.audio_params).toMatchObject({ format: 'pcm', sample_rate: 48000 })
  })

  it('redacts all configured credentials from remote error messages', async () => {
    const values = {
      VOLC_SPEECH_API_KEY: 'sensitive-key',
      VOLC_SPEECH_APP_ID: 'app-123',
      VOLC_SPEECH_ACCESS_KEY: 'access-456',
    }
    const ctx = context(
      new Response(JSON.stringify({ code: '45000001', message: Object.values(values).join(' ') }), {
        status: 400,
      }),
      values,
    )
    await expect(
      doubaoProvider.submit(
        { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'fixture' } },
        ctx,
      ),
    ).rejects.toMatchObject({
      message: '豆包语音 45000001: [redacted] [redacted] [redacted]',
      retryable: false,
    })
  })

  it('does not suggest retrying a generation after unknown network submission state', async () => {
    const ctx = context()
    vi.mocked(ctx.fetch).mockRejectedValueOnce(new TypeError('connection closed'))
    await expect(
      doubaoProvider.submit(
        { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'fixture' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
    expect(ctx.fetch).toHaveBeenCalledTimes(1)
  })

  it('validates credentials locally without a billable request', async () => {
    const ctx = context()
    await doubaoProvider.test!(ctx)
    expect(ctx.fetch).not.toHaveBeenCalled()
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('尚未验证远端'))
    await expect(doubaoProvider.test!(context(undefined, {}))).rejects.toMatchObject({
      code: 'auth',
    })
    expect(doubaoPlugin.plugin.manifest.permissions.network).toEqual(['openspeech.bytedance.com'])
    expect(doubaoPlugin.plugin.manifest.permissions.assets).toBe('read')
  })

  it('concatenates audio across NDJSON and adjacent JSON objects', async () => {
    const raw =
      '{"code":0,"data":"AQI="}\n{"code":0,"data":"AwQ="}{"code":20000000,"message":"end } \\""}'
    const ctx = context(new Response(raw))
    const result = await doubaoProvider.submit(
      {
        capability: 'audio.speech',
        model: 'seed-tts-2.0',
        input: { text: '你好', speed: 1.25, instruction: '温柔' },
      },
      ctx,
    )
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [{ data: new Uint8Array([1, 2, 3, 4]), mime: 'audio/mpeg' }],
    })
    const [url, init] = vi.mocked(ctx.fetch).mock.calls[0]!
    expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional')
    expect(init?.headers).toMatchObject({
      'X-Api-Key': 'test-key',
      'X-Api-Resource-Id': 'seed-tts-2.0',
    })
    const body = JSON.parse(String(init?.body))
    expect(body.req_params.audio_params.speech_rate).toBe(25)
    expect(JSON.parse(body.req_params.additions)).toEqual({ context_texts: ['温柔'] })
  })

  it('supports old App Key and Access Key without putting credentials in the body', async () => {
    const ctx = context(new Response('{"code":20000000,"data":"AQI="}'), {
      VOLC_SPEECH_APP_ID: 'app',
      VOLC_SPEECH_ACCESS_KEY: 'access',
    })
    await doubaoProvider.submit(
      {
        capability: 'audio.speech',
        model: 'seed-icl-2.0',
        input: { text: '你好', voice: 'S_example' },
      },
      ctx,
    )
    const init = vi.mocked(ctx.fetch).mock.calls[0]![1]!
    expect(init.headers).toMatchObject({ 'X-Api-App-Key': 'app', 'X-Api-Access-Key': 'access' })
    expect(init.headers).not.toHaveProperty('X-Api-Key')
    expect(String(init.body)).not.toContain('access')
  })

  it.each([
    '{"code":0,"data":"AQI="}',
    '{"code":20000000,"data":"!bad!"}',
    '{"code":0,"data":"AQI="}{',
  ])('rejects incomplete or corrupt speech instead of accepting partial audio', async (raw) => {
    await expect(
      doubaoProvider.submit(
        { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: '你好' } },
        context(new Response(raw)),
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
  })

  it('sends Seed Audio music and duration as prompt instructions', async () => {
    const ctx = context(new Response('{"code":20000000,"audio":"AQI="}'))
    await doubaoProvider.submit(
      {
        capability: 'audio.music',
        model: 'seed-audio-1.0',
        input: { prompt: '钢琴', duration: 10 },
      },
      ctx,
    )
    const [url, init] = vi.mocked(ctx.fetch).mock.calls[0]!
    expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/create')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'seed-audio-1.0',
      text_prompt: expect.stringContaining('目标时长 10 秒'),
    })
  })

  it('reads the asset and uploads inline base64 for flash ASR', async () => {
    const ctx = context(
      new Response('{"result":{"text":"你好"}}', { headers: { 'X-Api-Status-Code': '20000000' } }),
    )
    const result = await doubaoProvider.submit(
      {
        capability: 'audio.transcribe',
        model: 'bigmodel',
        input: { audio: { assetId: 'fixture', kind: 'audio' }, language: 'zh-CN' },
      },
      ctx,
    )
    expect(result).toEqual({ state: 'succeeded', outputs: [{ type: 'text', text: '你好' }] })
    expect(ctx.files.read).toHaveBeenCalledWith({ assetId: 'fixture', kind: 'audio' })
    const init = vi.mocked(ctx.fetch).mock.calls[0]![1]!
    expect(init.headers).toMatchObject({
      'X-Api-Sequence': '-1',
      'X-Api-Resource-Id': 'volc.bigasr.auc_turbo',
    })
    expect(JSON.parse(String(init.body)).audio).toEqual({
      data: 'AQID',
      format: 'wav',
      language: 'zh-CN',
    })
  })

  it('returns utterance timings as transcript segments in seconds', async () => {
    const ctx = context(
      new Response(
        JSON.stringify({
          result: {
            text: '你好。再见。',
            utterances: [
              { text: '你好。', start_time: 120, end_time: 900 },
              { text: '再见。', start_time: 1000, end_time: 1800 },
            ],
          },
        }),
        { headers: { 'X-Api-Status-Code': '20000000' } },
      ),
    )
    const result = await doubaoProvider.submit(
      {
        capability: 'audio.transcribe',
        model: 'bigmodel',
        input: { audio: { assetId: 'fixture', kind: 'audio' } },
      },
      ctx,
    )
    expect(result).toEqual({
      state: 'succeeded',
      outputs: [
        { type: 'text', text: '你好。再见。' },
        {
          type: 'json',
          value: {
            segments: [
              { start: 0.12, end: 0.9, text: '你好。' },
              { start: 1, end: 1.8, text: '再见。' },
            ],
          },
        },
      ],
    })
    const init = vi.mocked(ctx.fetch).mock.calls[0]![1]!
    expect(JSON.parse(String(init.body)).request).toMatchObject({ show_utterances: true })
  })

  it('returns empty text for documented silent audio status', async () => {
    const ctx = context(new Response('{}', { headers: { 'X-Api-Status-Code': '20000003' } }))
    await expect(
      doubaoProvider.submit(
        {
          capability: 'audio.transcribe',
          model: 'bigmodel',
          input: { audio: { assetId: 'silent', kind: 'audio' } },
        },
        ctx,
      ),
    ).resolves.toEqual({ state: 'succeeded', outputs: [{ type: 'text', text: '' }] })
  })

  it.each([
    [401, undefined, 'auth'],
    [429, undefined, 'rate_limit'],
    [503, undefined, 'unavailable'],
    [200, '45000001', 'invalid_input'],
  ])('normalizes HTTP and business errors (%s, %s)', async (status, code, expected) => {
    const ctx = context(
      new Response('{"message":"failed"}', {
        status,
        headers: code ? { 'X-Api-Status-Code': code } : {},
      }),
    )
    await expect(
      doubaoProvider.submit(
        { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'hello' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: expected })
  })

  it('rejects a mismatched model before reading assets or sending a request', async () => {
    const ctx = context()
    await expect(
      doubaoProvider.submit(
        { capability: 'audio.speech', model: 'seed-audio-1.0', input: { text: 'hello' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(ctx.fetch).not.toHaveBeenCalled()
    expect(ctx.files.read).not.toHaveBeenCalled()
  })
})

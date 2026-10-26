import { describe, expect, it, vi } from 'vite-plus/test'
import { fakeContext, requestBody } from '../testing'
import { doubaoProvider } from '.'

function context(
  response?: Response,
  secret: Record<string, string> = { VOLC_SPEECH_API_KEY: 'test-key' },
) {
  return fakeContext(doubaoProvider, response ? [response] : [], { secret, mime: 'audio/wav' }).ctx
}

describe('Doubao Speech HTTP contracts', () => {
  it.each([500, 502, 503, 504])(
    'HTTP %s 保留请求 ID、平台 logid 与提交未知，不自动重试',
    async (status) => {
      const ctx = context(
        new Response('gateway timeout', {
          status,
          headers: { 'X-Tt-Logid': 'platform-log-504' },
        }),
      )
      const error = await doubaoProvider
        .submit(
          {
            capability: 'audio.speech',
            model: 'seed-tts-2.0',
            input: { text: 'fixture' },
          },
          ctx,
        )
        .catch((err: unknown) => err)
      const init = vi.mocked(ctx.fetch).mock.calls[0]![1]!
      const id = new Headers(init.headers).get('X-Api-Request-Id')!
      expect(error).toMatchObject({
        code: status === 504 ? 'timeout' : 'unavailable',
        outcome: 'unknown',
        retryable: false,
        message: expect.stringContaining(id),
      })
      expect((error as Error).message).toContain('platform-log-504')
      expect(ctx.fetch).toHaveBeenCalledTimes(1)
    },
  )
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
    const body = requestBody(vi.mocked(ctx.fetch))
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
      message: expect.stringContaining('豆包语音 45000001: [redacted] [redacted] [redacted]'),
    })
  })

  it.each(['network', 'body', 'parse'] as const)(
    '%s 失败仍保留核查标识和提交未知状态',
    async (mode) => {
      const response =
        mode === 'body'
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new TypeError('terminated'))
                },
              }),
              { headers: { 'X-Tt-Logid': 'stream-log-id' } },
            )
          : new Response('{"code":0,"data":"AQID"}', { headers: { 'X-Tt-Logid': 'stream-log-id' } })
      const ctx = context(response)
      if (mode === 'network')
        vi.mocked(ctx.fetch).mockRejectedValueOnce(new TypeError('disconnected'))
      const error = await doubaoProvider
        .submit(
          {
            capability: 'audio.speech',
            model: 'seed-tts-2.0',
            input: { text: 'private fixture text' },
          },
          ctx,
        )
        .catch((err: unknown) => err)
      const id = new Headers(vi.mocked(ctx.fetch).mock.calls[0]![1]?.headers).get(
        'X-Api-Request-Id',
      )!
      expect(error).toMatchObject({
        code: 'unavailable',
        retryable: false,
        outcome: 'unknown',
        message: expect.stringContaining(id),
      })
      if (mode !== 'network') expect((error as Error).message).toContain('stream-log-id')
      expect(ctx.fetch).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain('private fixture text')
      expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain('test-key')
    },
  )

  it('响应 logid 中的配置密钥同样脱敏', async () => {
    const ctx = context(
      new Response('timeout', { status: 504, headers: { 'X-Tt-Logid': 'test-key' } }),
    )
    const error = await doubaoProvider
      .submit(
        { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'fixture' } },
        ctx,
      )
      .catch((err: unknown) => err)
    expect((error as Error).message).toContain('平台日志 ID [redacted]')
    expect((error as Error).message).not.toContain('test-key')
    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain('test-key')
  })

  it('分块响应读到一半断开时提交结果未知，不可重试', async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"code":0,'))
          controller.error(new TypeError('terminated'))
        },
      }),
    )
    await expect(
      doubaoProvider.submit(
        { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'fixture' } },
        context(broken),
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
  })

  it('validates credentials locally without a billable request', async () => {
    const ctx = context()
    await doubaoProvider.test!(ctx)
    expect(ctx.fetch).not.toHaveBeenCalled()
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('尚未验证远端'))
    await expect(doubaoProvider.test!(context(undefined, {}))).rejects.toMatchObject({
      code: 'auth',
    })
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

  it.each(['invalid sample_rate: 44100', 'max tokens exceeds model limit'])(
    '400 参数错误“%s”归为 invalid_input，不误判成限流或鉴权',
    async (message) => {
      const ctx = context(
        new Response(JSON.stringify({ code: 45000000, message }), { status: 400 }),
      )
      await expect(
        doubaoProvider.submit(
          { capability: 'audio.speech', model: 'seed-tts-2.0', input: { text: 'hello' } },
          ctx,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    },
  )

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

  it('合成 2.0 收到复刻音色时自动改走复刻 2.0 资源', async () => {
    const ctx = context(new Response('{"code":20000000,"data":"AQI="}'))
    await doubaoProvider.submit(
      {
        capability: 'audio.speech',
        model: 'seed-tts-2.0',
        input: { text: '你好', voice: 'S_abc' },
      },
      ctx,
    )
    const init = vi.mocked(ctx.fetch).mock.calls[0]![1]!
    expect(init.headers).toMatchObject({ 'X-Api-Resource-Id': 'seed-icl-2.0' })
  })

  it('复刻上传样本到控制台分配的音色 ID，训练状态按 get_voice 归一', async () => {
    const ctx = fakeContext(
      doubaoProvider,
      [
        Response.json({ speaker_id: 'S_abc' }),
        Response.json({ speaker_id: 'S_abc', status: 0 }),
        Response.json({ speaker_id: 'S_abc', status: 4 }),
        Response.json({ speaker_id: 'S_abc', status: 3 }),
      ],
      { secret: { VOLC_SPEECH_API_KEY: 'test-key' }, mime: 'audio/mpeg' },
    ).ctx
    const sample = { assetId: 'a', kind: 'audio' as const }
    await expect(
      doubaoProvider.voiceClone!.clone({ voiceId: 'S_abc', sample }, ctx),
    ).resolves.toEqual({
      status: 'training',
    })
    const [url, init] = vi.mocked(ctx.fetch).mock.calls[0]!
    expect(url).toBe('https://openspeech.bytedance.com/api/v3/tts/voice_clone')
    expect(init!.headers).not.toHaveProperty('X-Api-Resource-Id')
    expect(JSON.parse(String(init!.body))).toMatchObject({
      speaker_id: 'S_abc',
      audio: { data: 'AQID', format: 'mp3' },
    })
    const status = doubaoProvider.voiceClone!.status!
    await expect(status('S_abc', ctx)).resolves.toEqual({ status: 'training' })
    await expect(status('S_abc', ctx)).resolves.toEqual({ status: 'ready' })
    await expect(status('S_abc', ctx)).resolves.toMatchObject({ status: 'failed' })
  })

  it('复刻只接受 S_ 音色 ID，平台错误码照常报出', async () => {
    const sample = { assetId: 'a', kind: 'audio' as const }
    await expect(
      doubaoProvider.voiceClone!.clone({ voiceId: 'abc', sample }, context()),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const ctx = fakeContext(
      doubaoProvider,
      [Response.json({ code: 45001105, message: 'speaker permission denied' })],
      { secret: { VOLC_SPEECH_API_KEY: 'test-key' }, mime: 'audio/wav' },
    ).ctx
    await expect(
      doubaoProvider.voiceClone!.clone({ voiceId: 'S_abc', sample }, ctx),
    ).rejects.toThrow('speaker permission denied')
  })
})

describe('豆包音色设计及自定义复刻', () => {
  it('四秒样本不按建议时长拦截，自定义 ID 使用后付费协议，默认关闭降噪和归一化', async () => {
    const { ctx, body } = fakeContext(doubaoProvider, [{ status: 2 }], {
      mime: 'audio/wav',
      duration: 4,
    })
    await expect(
      doubaoProvider.voiceClone!.clone(
        { voiceId: 'pleinabcdefgh', idMode: 'custom', sample: { assetId: 'a', kind: 'audio' } },
        ctx,
      ),
    ).resolves.toEqual({ status: 'ready' })
    expect(body()).toMatchObject({
      speaker_id: 'custom_speaker_id',
      custom_speaker_id: 'pleinabcdefgh',
      language: 0,
      extra_params: { enable_audio_denoise: false, disable_volume_normalization: true },
    })
  })
  it('文字和图片设计使用独立接口，成功状态立即可用', async () => {
    const { ctx, body, fetch } = fakeContext(doubaoProvider, [{ status: 4 }], { mime: 'image/png' })
    await expect(
      doubaoProvider.voiceDesign!.design(
        {
          voiceId: 'S_abc',
          prompt: '温柔女声',
          previewText: '这是一段试听文本。',
          image: { assetId: 'a', kind: 'image' },
        },
        ctx,
      ),
    ).resolves.toEqual({ status: 'ready' })
    expect(fetch.mock.calls[0]![0]).toBe('https://openspeech.bytedance.com/api/v3/tts/voice_design')
    expect(body()).toMatchObject({
      speaker_id: 'S_abc',
      text: '这是一段试听文本。',
      prompt: { text_prompt: '温柔女声', image_prompt: { image_bytes: 'AQID' } },
    })
  })
  it('设计参数越界在提交前拒绝；平台失败状态保留', async () => {
    const { ctx, fetch } = fakeContext(doubaoProvider, [{ status: 3, message: '训练失败' }])
    await expect(
      doubaoProvider.voiceDesign!.design(
        { voiceId: 'S_abc', prompt: 'a'.repeat(201), previewText: '试听' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(
      doubaoProvider.voiceDesign!.design(
        { voiceId: 'S_abc', prompt: '女声', previewText: '试听' },
        ctx,
      ),
    ).resolves.toMatchObject({ status: 'failed' })
  })
  it('自定义音色合成走复刻资源，官方预置音色仍走合成资源', async () => {
    const { ctx, fetch } = fakeContext(doubaoProvider, [
      new Response('{"code":0,"data":"AQID"}\n{"code":20000000,"data":null}'),
    ])
    await doubaoProvider.submit(
      {
        capability: 'audio.speech',
        model: 'seed-tts-2.0',
        input: { text: '测试', voice: 'pleinabcdefgh' },
      },
      ctx,
    )
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ 'X-Api-Resource-Id': 'seed-icl-2.0' })
  })
})

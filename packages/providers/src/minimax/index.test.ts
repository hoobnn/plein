import { domainAllowed, type AssetRef } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { minimaxPlugin, minimaxProvider } from './index'

const setup = (replies?: unknown[]) => fakeContext(minimaxProvider, replies, { secret: 'test-key' })
const frame: AssetRef = { assetId: 'frame', kind: 'image', mime: 'image/png' }

describe('MiniMax 官方 HTTP 契约', () => {
  it('allows the actual image-result OSS domain and recognizes withdrawn music access', async () => {
    expect(minimaxProvider.models.find((model) => model.id === 'music-3.0')).toMatchObject({
      deprecated: true,
    })
    expect(
      domainAllowed(
        minimaxPlugin.plugin.manifest.permissions.network,
        'hailuo-image-algeng-data.oss-cn-wulanchabu.aliyuncs.com',
      ),
    ).toBe(true)
    expect(
      domainAllowed(
        minimaxPlugin.plugin.manifest.permissions.network,
        'algeng-video-infer.oss-cn-shanghai.aliyuncs.com',
      ),
    ).toBe(true)
    const { ctx } = setup([
      Response.json(
        {
          error: {
            type: 'not_supported',
            message: 'Music API is no longer available to new users',
          },
        },
        { status: 410 },
      ),
    ])
    await expect(
      minimaxProvider.submit(
        { capability: 'audio.music', model: 'music-3.0', input: { prompt: 'piano' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
  })
  it('连接测试只 GET models，不触发生成', async () => {
    const { ctx, fetch } = setup([{ data: [] }])
    await minimaxProvider.test!(ctx)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.minimax.cn/v1/models',
      expect.objectContaining({ method: 'GET', signal: ctx.signal }),
    )
  })
  it('对话使用 max_completion_tokens 并返回用量', async () => {
    const { ctx, body } = setup([
      {
        choices: [{ message: { content: '回答' } }],
        usage: { prompt_tokens: 4, completion_tokens: 6 },
      },
    ])
    const result = await minimaxProvider.submit(
      {
        capability: 'text.chat',
        model: 'MiniMax-M3.1-Flash',
        input: { messages: [{ role: 'user', content: '你好' }], maxTokens: 100 },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      max_completion_tokens: 100,
      stream: false,
      reasoning_split: true,
    })
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [{ type: 'text', text: '回答' }],
      usage: { inputTokens: 4, outputTokens: 6 },
    })
  })
  it('M2.7 保留迁移标记并拒绝图片，在计费请求前失败', async () => {
    expect(minimaxProvider.models.find((model) => model.id === 'MiniMax-M2.7')).toMatchObject({
      deprecated: true,
    })
    const { ctx, fetch } = setup()
    await expect(
      minimaxProvider.submit(
        {
          capability: 'text.chat',
          model: 'MiniMax-M2.7',
          input: { messages: [{ role: 'user', content: [{ type: 'image', image: frame }] }] },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('结构化生成把 Schema 写入指令并校验返回的 JSON', async () => {
    const { ctx, body } = setup([
      { choices: [{ message: { content: '```json\n{"shots":["雨停了"]}\n```' } }] },
    ])
    const result = await minimaxProvider.submit(
      {
        capability: 'text.chat',
        model: 'MiniMax-M3',
        input: {
          messages: [{ role: 'user', content: '写分镜' }],
          jsonSchema: {
            type: 'object',
            properties: { shots: { type: 'array', items: { type: 'string' } } },
            required: ['shots'],
          },
        },
      },
      ctx,
    )
    expect(body().messages[0]).toMatchObject({ role: 'system' })
    expect(body().messages[0].content).toContain('"shots"')
    expect(result).toMatchObject({ outputs: [{ type: 'json', value: { shots: ['雨停了'] } }] })
  })
  it.each([
    ['not JSON', 'stop'],
    ['{"shots":4}', 'stop'],
    ['{"shots":[]}', 'length'],
  ])('拒绝无效或截断的结构化输出：%s / %s', async (content, finish_reason) => {
    const { ctx } = setup([{ choices: [{ message: { content }, finish_reason }] }])
    await expect(
      minimaxProvider.submit(
        {
          capability: 'text.chat',
          model: 'MiniMax-M3',
          input: {
            messages: [{ role: 'user', content: '写分镜' }],
            jsonSchema: {
              type: 'object',
              properties: { shots: { type: 'array', items: { type: 'string' } } },
              required: ['shots'],
            },
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown', retryable: false })
  })
  it('参考图编码为 data URI；保留核心节点的 aspectRatio', async () => {
    const { ctx, body } = setup([{ data: { image_urls: ['https://cdn.hailuoai.com/image.jpg'] } }])
    await minimaxProvider.submit(
      {
        capability: 'image.generate',
        model: 'image-01',
        input: { prompt: '画一只猫', references: [frame], extra: { aspectRatio: '16:9' } },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      aspect_ratio: '16:9',
      subject_reference: [{ type: 'character', image_file: 'data:image/png;base64,AQID' }],
    })
  })
  it('分辨率档位按长边换算宽高，不再传 aspect_ratio', async () => {
    const { ctx, body } = setup([{ data: { image_urls: ['https://cdn.hailuoai.com/image.jpg'] } }])
    await minimaxProvider.submit(
      {
        capability: 'image.generate',
        model: 'image-01',
        input: { prompt: '画一只猫', resolution: '2K', extra: { aspectRatio: '16:9' } },
      },
      ctx,
    )
    expect(body()).toMatchObject({ width: 2048, height: 1152 })
    expect(body().aspect_ratio).toBeUndefined()
  })
  it('H3 首尾帧走 V2 并使用 adaptive', async () => {
    const { ctx, body, fetch } = setup([{ task_id: 'task-1' }])
    const result = await minimaxProvider.submit(
      {
        capability: 'video.generate',
        model: 'MiniMax-H3',
        input: {
          prompt: '跳舞',
          firstFrame: frame,
          lastFrame: frame,
          duration: 5,
          aspectRatio: '16:9',
        },
      },
      ctx,
    )
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.minimax.cn/v2/video_generation')
    expect(body()).toMatchObject({
      resolution: '2K',
      ratio: 'adaptive',
      content: [{ type: 'text', text: '跳舞' }, { role: 'first_frame' }, { role: 'last_frame' }],
    })
    expect(result).toMatchObject({ state: 'pending', remoteId: 'task-1' })
  })
  it('H3-Max 不支持 2K，在提交前失败', async () => {
    const { ctx, fetch } = setup()
    await expect(
      minimaxProvider.submit(
        {
          capability: 'video.generate',
          model: 'MiniMax-H3-Max',
          input: { prompt: '跳舞', resolution: '2K' },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('轮询 queued → succeeded 从 task.content.url 获取视频', async () => {
    const { ctx } = setup([
      { task: { id: 't1', status: 'queued' } },
      {
        task: {
          id: 't1',
          status: 'succeeded',
          content: { url: 'https://cdn.hailuoai.com/video.mp4' },
          duration: 5,
        },
      },
    ])
    expect(await minimaxProvider.poll!('t1', ctx)).toMatchObject({ state: 'pending' })
    expect(await minimaxProvider.poll!('t1', ctx)).toMatchObject({
      state: 'succeeded',
      outputs: [{ kind: 'video', url: 'https://cdn.hailuoai.com/video.mp4' }],
      usage: { seconds: 5 },
    })
  })
  it('取消先查状态，不 DELETE 成功记录', async () => {
    const { ctx, fetch } = setup([{ task: { id: 't1', status: 'succeeded' } }])
    await minimaxProvider.cancel!('t1', ctx)
    expect(fetch).toHaveBeenCalledTimes(1)
    const queued = setup([{ task: { id: 't2', status: 'queued' } }, {}])
    await minimaxProvider.cancel!('t2', queued.ctx)
    expect(queued.fetch).toHaveBeenLastCalledWith(
      'https://api.minimax.cn/v2/video_generation/t2',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
  it.each([{ task: { id: 'other', status: 'queued' } }, {}])(
    '取消查询缺少匹配任务时不发 DELETE：%j',
    async (reply) => {
      const { ctx, fetch } = setup([reply])
      await expect(minimaxProvider.cancel!('t1', ctx)).rejects.toMatchObject({ code: 'unknown' })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
    },
  )
  it('hex 配音转为二进制音频并归一化毫秒用量', async () => {
    const { ctx, body } = setup([
      { data: { audio: '0102ff' }, extra_info: { audio_length: 1500, usage_characters: 2 } },
    ])
    const result = await minimaxProvider.submit(
      { capability: 'audio.speech', model: 'speech-2.8-hd', input: { text: '你好', speed: 1.2 } },
      ctx,
    )
    expect(body()).toMatchObject({
      output_format: 'hex',
      voice_setting: { voice_id: 'male-qn-qingse', speed: 1.2 },
    })
    expect(result).toMatchObject({
      outputs: [{ mime: 'audio/mpeg', data: new Uint8Array([1, 2, 255]) }],
      usage: { seconds: 1.5, characters: 2 },
    })
  })
  it('音乐使用 instrumental，时长是软约束', async () => {
    const { ctx, body } = setup([{ data: { audio: '0102' } }])
    await minimaxProvider.submit(
      {
        capability: 'audio.music',
        model: 'music-3.0',
        input: { prompt: '轻快弦乐', duration: 30 },
      },
      ctx,
    )
    expect(body()).toMatchObject({ is_instrumental: true, output_format: 'hex', lyrics: '' })
    expect(body()).not.toHaveProperty('duration')
    expect(ctx.log).toHaveBeenCalled()
  })
  it('HTTP 200 中业务错误也归一化并脱敏', async () => {
    const { ctx } = setup([{ base_resp: { status_code: 1008, status_msg: 'balance test-key' } }])
    await expect(
      minimaxProvider.submit(
        { capability: 'audio.speech', model: 'speech-2.8-hd', input: { text: '你好' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'quota', message: 'MiniMax：balance [redacted]' })
  })
  it.each([
    [1004, 200, 'auth'],
    [2049, 200, 'auth'],
    [1026, 200, 'content_policy'],
    [1043, 200, 'content_policy'],
    [1013, 200, 'unavailable'],
    [2013, 200, 'invalid_input'],
    [9999, 429, 'rate_limit'],
  ] as const)(
    '业务码 %i（HTTP %i）归为 %s，未知业务码按 HTTP 状态',
    async (code, status, expected) => {
      const { ctx } = setup([
        Response.json({ base_resp: { status_code: code, status_msg: 'failed' } }, { status }),
      ])
      await expect(
        minimaxProvider.submit(
          { capability: 'audio.speech', model: 'speech-2.8-hd', input: { text: '你好' } },
          ctx,
        ),
      ).rejects.toMatchObject({ code: expected })
    },
  )
  it('查询遇网关错误页或 429 可重试，提交遇 502 不可重试', async () => {
    const gateway = () => new Response('<html>bad gateway</html>', { status: 502 })
    const { ctx } = setup([
      gateway(),
      Response.json(
        { base_resp: { status_code: 1002, status_msg: 'rate limit' } },
        { status: 429 },
      ),
      gateway(),
    ])
    for (let i = 0; i < 2; i++)
      await expect(minimaxProvider.poll!('123', ctx)).rejects.toMatchObject({ retryable: true })
    await expect(
      minimaxProvider.submit(
        { capability: 'video.generate', model: 'MiniMax-H3', input: { prompt: '跳舞' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
  })
})

// 网关响应没有明确未受理合同；不能只禁止自动重试却丢掉受理未知。
it.each([408, 500, 502, 503, 504])(
  'POST HTTP %i 的 HTML / JSON 网关响应保留 unknown',
  async (status) => {
    for (const response of [
      new Response('<html>gateway</html>', { status }),
      Response.json({ error: { message: 'gateway' } }, { status }),
    ]) {
      const { ctx, fetch } = setup([response])
      await expect(
        minimaxProvider.submit(
          { capability: 'video.generate', model: 'MiniMax-H3', input: { prompt: 'local' } },
          ctx,
        ),
      ).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
      expect(fetch).toHaveBeenCalledTimes(1)
    }
  },
)

describe('MiniMax 声音复刻', () => {
  const sample: AssetRef = { assetId: 'a', kind: 'audio' }

  it('先 multipart 上传样本，再用 file_id 提交复刻', async () => {
    const { ctx, fetch } = fakeContext(
      minimaxProvider,
      [
        { file: { file_id: 263891729178625 }, base_resp: { status_code: 0 } },
        { input_sensitive: { type: 0 }, demo_audio: '', base_resp: { status_code: 0 } },
      ],
      { secret: 'test-key', mime: 'audio/mpeg', duration: 30 },
    )
    await expect(
      minimaxProvider.voiceClone!.clone({ voiceId: 'pleinabcdefgh', sample }, ctx),
    ).resolves.toEqual({ status: 'ready' })
    const [uploadUrl, upload] = fetch.mock.calls[0]!
    expect(uploadUrl).toBe('https://api.minimax.cn/v1/files/upload')
    expect(upload!.headers).not.toHaveProperty('Content-Type')
    const form = upload!.body as FormData
    expect(form.get('purpose')).toBe('voice_clone')
    expect((form.get('file') as File).name).toBe('sample.mp3')
    expect(fetch.mock.calls[1]![0]).toBe('https://api.minimax.cn/v1/voice_clone')
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body))).toMatchObject({
      voice_id: 'pleinabcdefgh',
    })
  })

  it('样本过短直接拦下，未实名按鉴权失败报', async () => {
    const short = fakeContext(minimaxProvider, [], { secret: 'k', mime: 'audio/wav', duration: 3 })
    await expect(
      minimaxProvider.voiceClone!.clone({ voiceId: 'pleinabcdefgh', sample }, short.ctx),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(short.fetch).not.toHaveBeenCalled()
    const { ctx } = fakeContext(
      minimaxProvider,
      [
        { file: { file_id: 1 }, base_resp: { status_code: 0 } },
        { base_resp: { status_code: 2038, status_msg: 'no cloning permission' } },
      ],
      { secret: 'k', mime: 'audio/wav', duration: 30 },
    )
    await expect(
      minimaxProvider.voiceClone!.clone({ voiceId: 'pleinabcdefgh', sample }, ctx),
    ).rejects.toMatchObject({ code: 'auth' })
  })
})

describe('MiniMax 音色设计与增强参考', () => {
  it('设计无需上传样本，返回平台音色 ID 并解码 hex 试听', async () => {
    const { ctx, fetch, body } = fakeContext(minimaxProvider, [
      { voice_id: 'designed123', trial_audio: '010203', base_resp: { status_code: 0 } },
    ])
    const result = await minimaxProvider.voiceDesign!.design(
      { voiceId: 'pleinabcdefgh', prompt: '低沉男声', previewText: '这是试听。' },
      ctx,
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![0]).toBe('https://api.minimax.cn/v1/voice_design')
    expect(body()).toEqual({
      voice_id: 'pleinabcdefgh',
      prompt: '低沉男声',
      preview_text: '这是试听。',
    })
    expect(result).toMatchObject({
      status: 'ready',
      voiceId: 'designed123',
      preview: { data: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' },
    })
  })
  it('增强音频单独上传为 prompt_audio，试听带合成模型，显式传递处理选项', async () => {
    const { ctx, fetch, body } = fakeContext(
      minimaxProvider,
      [{ file: { file_id: 1 } }, { file: { file_id: 2 } }, { base_resp: { status_code: 0 } }],
      { mime: 'audio/wav', duration: 20 },
    )
    vi.mocked(ctx.files.read)
      .mockResolvedValueOnce({ data: new Uint8Array([1]), mime: 'audio/wav', duration: 20 })
      .mockResolvedValueOnce({ data: new Uint8Array([2]), mime: 'audio/wav', duration: 4 })
    await minimaxProvider.voiceClone!.clone(
      {
        voiceId: 'pleinabcdefgh',
        sample: { assetId: 'a', kind: 'audio' },
        promptSample: { assetId: 'b', kind: 'audio' },
        promptText: '参考文字',
        previewText: '试听文字',
        noiseReduction: true,
        volumeNormalization: true,
      },
      ctx,
    )
    expect((fetch.mock.calls[1]![1]!.body as FormData).get('purpose')).toBe('prompt_audio')
    expect(body(2)).toMatchObject({
      file_id: 1,
      clone_prompt: { prompt_audio: 2, prompt_text: '参考文字' },
      model: 'speech-2.8-hd',
      text: '试听文字',
      need_noise_reduction: true,
      need_volume_normalization: true,
    })
  })
  it('增强参考达到八秒，提交前拒绝，不产生样本上传', async () => {
    const { ctx, fetch } = fakeContext(minimaxProvider, [], { mime: 'audio/wav', duration: 20 })
    vi.mocked(ctx.files.read)
      .mockResolvedValueOnce({ data: new Uint8Array([1]), mime: 'audio/wav', duration: 20 })
      .mockResolvedValueOnce({ data: new Uint8Array([2]), mime: 'audio/wav', duration: 8 })
    await expect(
      minimaxProvider.voiceClone!.clone(
        {
          voiceId: 'pleinabcdefgh',
          sample: { assetId: 'a', kind: 'audio' },
          promptSample: { assetId: 'b', kind: 'audio' },
          promptText: '文字',
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

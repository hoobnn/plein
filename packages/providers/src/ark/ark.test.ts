import { describeProvider, type ProviderContext } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import { arkPlugin, arkProvider } from './index'

const CHAT = 'doubao-seed-2-1-pro-260628'
const IMAGE = 'doubao-seedream-5-0-pro-260628'
const VIDEO = 'doubao-seedance-2-5-260628'
const ref = { assetId: 'local-image', kind: 'image' as const }

function harness(responses: Array<{ body: unknown; status?: number }> = []) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const next = responses.shift()
    if (!next) throw new Error('Unexpected fetch')
    return Response.json(next.body, { status: next.status ?? 200 })
  })
  const read = vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' }))
  const ctx: ProviderContext<ReturnType<typeof arkProvider.settings.parse>> = {
    settings: arkProvider.settings.parse({}),
    secret: () => 'test-secret',
    fetch,
    signal: new AbortController().signal,
    log: () => {},
    files: { read },
  }
  const body = (index = 0) => JSON.parse(String(fetch.mock.calls[index]?.[1]?.body))
  return { ctx, fetch, read, body }
}

describe('火山方舟 Provider HTTP 契约（不调用云端）', () => {
  it('classifies unactivated models as authorization failures rather than malformed inputs', async () => {
    const { ctx } = harness([
      {
        status: 404,
        body: { error: { code: 'ModelNotOpen', message: 'Model service not activated' } },
      },
    ])
    await expect(
      arkProvider.submit(
        { capability: 'image.generate', model: IMAGE, input: { prompt: 'apple' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'auth', retryable: false })
  })
  it('声明仅需要的密钥、网络和资产读取权限，并提供默认设置', () => {
    expect(arkProvider.settings.parse({})).toEqual({
      customChatModel: '',
      customImageModel: '',
      customVideoModel: '',
    })
    expect(arkPlugin.plugin.manifest.permissions.assets).toBe('read')
    expect(arkPlugin.plugin.manifest.permissions.secrets).toEqual(['ARK_API_KEY'])
    expect(arkPlugin.plugin.manifest.permissions.network).toContain('*.volces.com')
  })

  it('连接测试只查询任务列表，不触发生成计费', async () => {
    const { ctx, fetch } = harness([{ body: { items: [] } }])
    await arkProvider.test!(ctx)
    expect(fetch).toHaveBeenCalledWith(
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_size=1',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
        signal: ctx.signal,
      }),
    )
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined()
  })

  it('对话图片经资产权限读入后使用 data URL，传递 JSON Schema 并归一化用量', async () => {
    const { ctx, body } = harness([
      {
        body: {
          choices: [{ message: { content: '{"answer":42}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 8 },
        },
      },
    ])
    const schema = { type: 'object', properties: { answer: { type: 'integer' } } }
    const result = await arkProvider.submit(
      {
        capability: 'text.chat',
        model: CHAT,
        input: {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'hello' },
                { type: 'image', image: ref },
              ],
            },
          ],
          jsonSchema: schema,
          temperature: 0.2,
          maxTokens: 100,
        },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      model: CHAT,
      stream: false,
      temperature: 0.2,
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'plein_output', schema, strict: true },
      },
    })
    expect(result).toEqual({
      state: 'succeeded',
      outputs: [{ type: 'json', value: { answer: 42 } }],
      usage: { inputTokens: 3, outputTokens: 8 },
    })
  })

  it('自定义模型槽映射至设置中的 Endpoint ID', async () => {
    const { ctx, body } = harness([{ body: { choices: [{ message: { content: 'OK' } }] } }])
    ctx.settings.customChatModel = 'ep-custom-chat'
    await arkProvider.submit(
      {
        capability: 'text.chat',
        model: 'custom-chat',
        input: { messages: [{ role: 'user', content: 'hello' }] },
      },
      ctx,
    )
    expect(body().model).toBe('ep-custom-chat')
  })

  it('图片请求不发送本机 URL；解码 b64_json 到资产输出', async () => {
    const { ctx, body } = harness([
      { body: { data: [{ b64_json: 'AQID', output_format: 'png' }] } },
    ])
    const result = await arkProvider.submit(
      {
        capability: 'image.generate',
        model: IMAGE,
        input: { prompt: 'cat', references: [ref], width: 1024, height: 1024 },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      model: IMAGE,
      prompt: 'cat',
      image: 'data:image/png;base64,AQID',
      size: '1024x1024',
      response_format: 'b64_json',
    })
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [
        { type: 'file', kind: 'image', mime: 'image/png', data: new Uint8Array([1, 2, 3]) },
      ],
      usage: { images: 1 },
    })
  })

  it.each([
    [IMAGE, '16:9', '2048x1152'],
    [IMAGE, '9:16', '1152x2048'],
    [IMAGE, '1:1', '2048x2048'],
    [IMAGE, '4:3', '2048x1536'],
    [IMAGE, '3:4', '1536x2048'],
    ['doubao-seedream-5-0-flash-260915', '16:9', '2048x1152'],
    ['doubao-seedream-5-0-260128', '16:9', '2560x1440'],
  ])(
    '核心 image executor payload 的 %s / %s 映射为官方 size %s',
    async (model, aspectRatio, size) => {
      const { ctx, body } = harness([{ body: { data: [{ b64_json: 'AQID' }] } }])
      await arkProvider.submit(
        {
          capability: 'image.generate',
          model,
          input: { prompt: 'cat', references: [], count: 1, extra: { aspectRatio } },
        },
        ctx,
      )
      expect(body().size).toBe(size)
      expect(body()).not.toHaveProperty('aspectRatio')
    },
  )

  it.each([
    [IMAGE, '1K', '16:9', '1360x768'],
    [IMAGE, '2K', '9:16', '1536x2720'],
    ['doubao-seedream-5-0-260128', '4K', '1:1', '4096x4096'],
  ])('%s 的分辨率 %s 按画幅 %s 换算为 %s', async (model, resolution, aspectRatio, size) => {
    const { ctx, body } = harness([{ body: { data: [{ b64_json: 'AQID' }] } }])
    await arkProvider.submit(
      {
        capability: 'image.generate',
        model,
        input: { prompt: 'cat', resolution, extra: { aspectRatio } },
      },
      ctx,
    )
    expect(body().size).toBe(size)
  })

  it('模型不支持的分辨率直接报错', async () => {
    const { ctx, fetch } = harness([])
    await expect(
      arkProvider.submit(
        {
          capability: 'image.generate',
          model: IMAGE,
          input: { prompt: 'cat', resolution: '4K', extra: { aspectRatio: '16:9' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('明确的 extra.size 优先于通用 aspectRatio / width / height', async () => {
    const { ctx, body } = harness([{ body: { data: [{ b64_json: 'AQID' }] } }])
    await arkProvider.submit(
      {
        capability: 'image.generate',
        model: IMAGE,
        input: {
          prompt: 'cat',
          width: 1024,
          height: 1024,
          extra: { aspectRatio: '16:9', size: '1.5K' },
        },
      },
      ctx,
    )
    expect(body().size).toBe('1.5K')
    expect(body()).not.toHaveProperty('aspectRatio')
  })

  it('远端提交业务错误不可自动重新生成且错误文本不包含密钥', async () => {
    const { ctx } = harness([
      {
        body: {
          error: { code: 'RateLimitExceeded', message: 'test-secret rate limit test-secret' },
        },
        status: 429,
      },
      {
        body: {
          status: 'failed',
          error: { code: 'ServiceUnavailable', message: 'test-secret service unavailable' },
        },
      },
    ])
    await expect(
      arkProvider.submit(
        { capability: 'video.generate', model: VIDEO, input: { prompt: 'cat' } },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'rate_limit',
      message: '[redacted] rate limit [redacted]',
      retryable: false,
    })
    expect(await arkProvider.poll!('id', ctx)).toMatchObject({
      state: 'failed',
      error: { message: '[redacted] service unavailable', retryable: false },
    })
  })

  it('组图只为 Lite 构造官方 sequential 参数，不重复发起多次生成', async () => {
    const { ctx, body, fetch } = harness([{ body: { data: [{ b64_json: 'AQID' }] } }])
    await arkProvider.submit(
      {
        capability: 'image.generate',
        model: 'doubao-seedream-5-0-260128',
        input: { prompt: 'cat', count: 3 },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      sequential_image_generation: 'auto',
      sequential_image_generation_options: { max_images: 3 },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(
      arkProvider.submit(
        { capability: 'image.generate', model: IMAGE, input: { prompt: 'cat', count: 2 } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('视频首尾帧为图片 data URL，使用 adaptive 比例并保留远端 ID', async () => {
    const { ctx, body, fetch } = harness([{ body: { id: 'cgt-123' } }])
    const result = await arkProvider.submit(
      {
        capability: 'video.generate',
        model: VIDEO,
        input: { prompt: 'cat runs', firstFrame: ref, lastFrame: ref, duration: 5 },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      model: VIDEO,
      ratio: 'adaptive',
      resolution: '720p',
      duration: 5,
      content: [
        { type: 'text', text: 'cat runs' },
        {
          role: 'first_frame',
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AQID' },
        },
        { role: 'last_frame', type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      ],
    })
    expect(result).toEqual({ state: 'pending', remoteId: 'cgt-123', pollAfterMs: 5000 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('无效视频参数和非图片本地参考在计费请求前失败', async () => {
    const { ctx, fetch } = harness()
    for (const input of [
      { prompt: 'cat', duration: 1 },
      { prompt: 'cat', seed: 1 },
      { prompt: 'cat', firstFrame: ref, references: [ref] },
      { prompt: 'cat', references: [{ assetId: 'local-video', kind: 'video' as const }] },
      {
        prompt: 'cat',
        extra: {
          content: [{ type: 'video_url', video_url: { url: 'http://localhost/private.mp4' } }],
        },
      },
    ]) {
      await expect(
        arkProvider.submit({ capability: 'video.generate', model: VIDEO, input }, ctx),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('轮询跨进程只依赖 remoteId，支持 pending、成功、失败及取消状态', async () => {
    const { ctx, fetch } = harness([
      { body: { status: 'running' } },
      {
        body: {
          status: 'succeeded',
          content: { video_url: 'https://result.tos-cn-beijing.volces.com/clip.mp4' },
          duration: 5,
          usage: { completion_tokens: 100 },
        },
      },
      {
        body: {
          status: 'failed',
          error: { code: 'ContentPolicyViolation', message: 'content policy' },
        },
      },
      { body: { status: 'cancelled' } },
    ])
    expect(await arkProvider.poll!('id/escaped', ctx)).toEqual({
      state: 'pending',
      pollAfterMs: 5000,
    })
    expect(fetch.mock.calls[0]?.[0]).toContain('id%2Fescaped')
    expect(await arkProvider.poll!('id', ctx)).toMatchObject({
      state: 'succeeded',
      outputs: [{ kind: 'video', mime: 'video/mp4' }],
      usage: { seconds: 5, outputTokens: 100 },
    })
    expect(await arkProvider.poll!('id', ctx)).toMatchObject({
      state: 'failed',
      error: { code: 'content_policy', retryable: false },
    })
    expect(await arkProvider.poll!('id', ctx)).toMatchObject({
      state: 'failed',
      error: { code: 'cancelled', retryable: false },
    })
  })

  it('开了返回尾帧时多输出一张尾帧图片', async () => {
    const { ctx } = harness([
      {
        body: {
          status: 'succeeded',
          content: {
            video_url: 'https://result.tos-cn-beijing.volces.com/clip.mp4',
            last_frame_url: 'https://result.tos-cn-beijing.volces.com/last.png',
          },
        },
      },
    ])
    expect(await arkProvider.poll!('id', ctx)).toMatchObject({
      state: 'succeeded',
      outputs: [
        { kind: 'video', mime: 'video/mp4' },
        { kind: 'image', url: 'https://result.tos-cn-beijing.volces.com/last.png' },
      ],
    })
  })

  it('模型声明的专属参数转成 JSON Schema 下发，约束原样保留', () => {
    const seedance = describeProvider(arkProvider, 'volc/ark').models.find(
      (m) => m.id === 'doubao-seedance-2-5-260628',
    )!
    expect(seedance.limits).toMatchObject({ duration: { min: 4, max: 30 }, seed: false })
    expect(Object.keys((seedance.optionsSchema as { properties: object }).properties)).toEqual([
      'return_last_frame',
      'service_tier',
      'watermark',
      'draft',
    ])
    expect(seedance).not.toHaveProperty('options')
  })

  it('取消仅删除 queued 任务，避免 DELETE 成功任务导致产物记录丢失', async () => {
    const { ctx, fetch } = harness([
      { body: { status: 'queued' } },
      { body: {} },
      { body: { status: 'succeeded' } },
      { body: { status: 'running' } },
    ])
    await arkProvider.cancel!('id', ctx)
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('DELETE')
    await arkProvider.cancel!('id', ctx)
    await expect(arkProvider.cancel!('id', ctx)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it.each([
    [401, 'Unauthorized', 'auth'],
    [402, 'InsufficientBalance', 'quota'],
    [429, 'RateLimitExceeded', 'rate_limit'],
    [400, 'InvalidParameter', 'invalid_input'],
    [400, 'ContentPolicyViolation', 'content_policy'],
    [503, 'ServerOverloaded', 'unavailable'],
    [504, 'Timeout', 'timeout'],
  ] as const)('归一化 HTTP %i / %s → %s', async (status, code, normalized) => {
    const { ctx } = harness([{ body: { error: { code, message: code } }, status }])
    await expect(arkProvider.test!(ctx)).rejects.toMatchObject({ code: normalized })
  })

  it('传输失败不会自动重新提交生成，也不标记为可重试', async () => {
    const { ctx, fetch } = harness()
    fetch.mockRejectedValueOnce(new TypeError('network error'))
    await expect(
      arkProvider.submit(
        { capability: 'video.generate', model: VIDEO, input: { prompt: 'cat' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('拒绝缺少 ID / 畸形 JSON 输出以及权限外的产物 URL', async () => {
    const { ctx } = harness([
      { body: {} },
      { body: { choices: [{ message: { content: 'not JSON' } }] } },
      { body: { status: 'succeeded', content: { video_url: 'http://127.0.0.1/private.mp4' } } },
    ])
    await expect(
      arkProvider.submit(
        { capability: 'video.generate', model: VIDEO, input: { prompt: 'cat' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown' })
    await expect(
      arkProvider.submit(
        {
          capability: 'text.chat',
          model: CHAT,
          input: { messages: [{ role: 'user', content: 'hello' }], jsonSchema: {} },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown' })
    await expect(arkProvider.poll!('id', ctx)).rejects.toMatchObject({ code: 'unknown' })
  })
})

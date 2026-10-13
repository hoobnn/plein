import { describeProvider } from '@plein/plugin-sdk'
import { describe, expect, it } from 'vitest'
import { fakeContext, sse } from '../testing'
import { arkProvider } from './index'

const harness = (replies?: unknown[]) => fakeContext(arkProvider, replies)

const CHAT = 'doubao-seed-2-1-pro-260628'
const IMAGE = 'doubao-seedream-5-0-pro-260628'
const VIDEO = 'doubao-seedance-2-5-260628'
const ref = { assetId: 'local-image', kind: 'image' as const }
/** 对话的 SSE 回复：frames 依次是 chat.completion.chunk */
const chatSse = (frames: unknown[], done = true) =>
  sse(
    `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}${done ? 'data: [DONE]\n\n' : ''}`,
  )
const say = (content: string, usage?: unknown) =>
  chatSse([
    { choices: [{ index: 0, delta: { role: 'assistant', content } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) },
  ])

describe('火山方舟 Provider HTTP 契约（不调用云端）', () => {
  it('classifies unactivated models as authorization failures rather than malformed inputs', async () => {
    const { ctx } = harness([
      Response.json(
        { error: { code: 'ModelNotOpen', message: 'Model service not activated' } },
        { status: 404 },
      ),
    ])
    await expect(
      arkProvider.submit(
        { capability: 'image.generate', model: IMAGE, input: { prompt: 'apple' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'auth', retryable: false })
  })
  it('连接测试只查询任务列表，不触发生成计费', async () => {
    const { ctx, fetch } = harness([{ items: [] }])
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
      say('{"answer":42}', { prompt_tokens: 3, completion_tokens: 8 }),
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
      stream: true,
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

  it('豆包对话模型声明工具能力：工具声明随请求发送，模型的工具调用原样交回', async () => {
    expect(arkProvider.models.find((m) => m.id === CHAT)?.features).toContain('tools')
    const { ctx, body } = harness([
      chatSse([
        {
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_canvas', arguments: '{"depth":1}' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    ])
    const parameters = { type: 'object', properties: { depth: { type: 'integer' } } }
    const result = await arkProvider.submit(
      {
        capability: 'text.chat',
        model: CHAT,
        input: {
          messages: [{ role: 'user', content: '画布上有什么' }],
          tools: [{ name: 'get_canvas', description: '读画布', parameters }],
        },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      tools: [{ type: 'function', function: { name: 'get_canvas', parameters } }],
      tool_choice: 'auto',
    })
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [
        {
          type: 'tool_calls',
          calls: [{ id: 'call_1', name: 'get_canvas', arguments: { depth: 1 } }],
        },
      ],
    })
  })

  it('对话流没有以 [DONE] 结束视为中断', async () => {
    const { ctx } = harness([
      chatSse([{ choices: [{ index: 0, delta: { role: 'assistant', content: '半截' } }] }], false),
    ])
    await expect(
      arkProvider.submit(
        {
          capability: 'text.chat',
          model: CHAT,
          input: { messages: [{ role: 'user', content: 'hello' }] },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown' })
  })

  it('自定义模型槽映射至设置中的 Endpoint ID', async () => {
    const { ctx, body } = harness([say('OK')])
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
    const { ctx, body } = harness([{ data: [{ b64_json: 'AQID', output_format: 'png' }] }])
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
      const { ctx, body } = harness([{ data: [{ b64_json: 'AQID' }] }])
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
    const { ctx, body } = harness([{ data: [{ b64_json: 'AQID' }] }])
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
    const { ctx, body } = harness([{ data: [{ b64_json: 'AQID' }] }])
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

  it('提交报错和失败任务的错误文本不包含密钥', async () => {
    const { ctx } = harness([
      Response.json(
        { error: { code: 'InvalidParameter', message: 'test-secret bad test-secret' } },
        { status: 400 },
      ),
      {
        status: 'failed',
        error: { code: 'ServiceUnavailable', message: 'test-secret service unavailable' },
      },
    ])
    await expect(
      arkProvider.submit(
        { capability: 'video.generate', model: VIDEO, input: { prompt: 'cat' } },
        ctx,
      ),
    ).rejects.toMatchObject({ message: '[redacted] bad [redacted]' })
    expect(await arkProvider.poll!('id', ctx)).toMatchObject({
      state: 'failed',
      error: { message: '[redacted] service unavailable' },
    })
  })

  it('组图只为 Lite 构造官方 sequential 参数，不重复发起多次生成', async () => {
    const { ctx, body, fetch } = harness([{ data: [{ b64_json: 'AQID' }] }])
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
    const { ctx, body, fetch } = harness([{ id: 'cgt-123' }])
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
      { status: 'running' },
      {
        status: 'succeeded',
        content: { video_url: 'https://result.tos-cn-beijing.volces.com/clip.mp4' },
        duration: 5,
        usage: { completion_tokens: 100 },
      },
      { status: 'failed', error: { code: 'ContentPolicyViolation', message: 'content policy' } },
      { status: 'cancelled' },
    ])
    expect(await arkProvider.poll!('id/escaped', ctx)).toEqual({
      state: 'pending',
      pollAfterMs: 5000,
      remote: 'running',
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
        status: 'succeeded',
        content: {
          video_url: 'https://result.tos-cn-beijing.volces.com/clip.mp4',
          last_frame_url: 'https://result.tos-cn-beijing.volces.com/last.png',
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

  it('Seedance 声明 4–30 秒时长且不支持 seed', () => {
    const seedance = describeProvider(arkProvider, 'volc/ark').models.find((m) => m.id === VIDEO)!
    expect(seedance.limits).toMatchObject({ duration: { min: 4, max: 30 }, seed: false })
  })

  it('取消仅删除 queued 任务，避免 DELETE 成功任务导致产物记录丢失', async () => {
    const { ctx, fetch } = harness([
      { status: 'queued' },
      {},
      { status: 'succeeded' },
      { status: 'running' },
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
    const { ctx } = harness([Response.json({ error: { code, message: code } }, { status })])
    await expect(arkProvider.test!(ctx)).rejects.toMatchObject({ code: normalized })
  })

  it('提交遇 503 不可重试，轮询遇 503 可重试，宿主据此续轮询', async () => {
    const busy = () =>
      Response.json({ error: { code: 'ServerOverloaded', message: 'busy' } }, { status: 503 })
    const { ctx, fetch } = harness([busy(), busy()])
    await expect(
      arkProvider.submit(
        { capability: 'video.generate', model: VIDEO, input: { prompt: 'cat' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(arkProvider.poll!('id', ctx)).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true,
    })
  })

  it('拒绝缺少 ID / 畸形 JSON 输出以及权限外的产物 URL', async () => {
    const { ctx } = harness([
      {},
      say('not JSON'),
      { status: 'succeeded', content: { video_url: 'http://127.0.0.1/private.mp4' } },
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

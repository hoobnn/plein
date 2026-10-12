import { describe, expect, it } from 'vitest'
import { fakeContext, sse } from '../testing'
import { bailianProvider } from './index'

const setup = (replies?: unknown[]) => fakeContext(bailianProvider, replies, { secret: 'sk-test' })
const stream =
  'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
describe('百炼 API 契约', () => {
  it('upgrades official HTTP audio result URL to HTTPS without changing its signature', async () => {
    const { ctx } = setup([
      {
        output: {
          audio: {
            data: '',
            url: 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?Signature=fixture&Expires=123',
          },
        },
      },
    ])
    expect(
      await bailianProvider.submit(
        { capability: 'audio.speech', model: 'qwen3-tts-flash', input: { text: '你好' } },
        ctx,
      ),
    ).toMatchObject({
      state: 'succeeded',
      outputs: [
        {
          type: 'file',
          url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?Signature=fixture&Expires=123',
        },
      ],
    })
  })
  it('连接测试只检查本地密钥，不计费', async () => {
    const { ctx, fetch } = setup()
    await bailianProvider.test?.(ctx)
    expect(fetch).not.toHaveBeenCalled()
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('未验证'))
  })
  it('缺少密钥时不联网', async () => {
    const { ctx, fetch } = setup()
    ctx.secret = () => undefined
    await expect(bailianProvider.test?.(ctx)).rejects.toMatchObject({ code: 'auth' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('对话走流式兼容 API，归一化回答和 usage，保护 model/messages', async () => {
    const { ctx, fetch, body } = setup([sse(stream)])
    const result = await bailianProvider.submit(
      {
        capability: 'text.chat',
        model: 'qwen3.7-plus',
        input: {
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 30,
          extra: { model: 'evil', stream: false },
        },
      },
      ctx,
    )
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [{ type: 'text', text: '你好' }],
      usage: { inputTokens: 3, outputTokens: 2 },
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    expect(body()).toMatchObject({
      model: 'qwen3.7-plus',
      stream: true,
      max_tokens: 30,
    })
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
  })
  it('工具调用：工具随请求发送，模型的调用作为 tool_calls 返回；文字边生成边回调', async () => {
    const call = {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'create_node', arguments: '{"type":"plein/image"}' },
    }
    const frames = [
      { choices: [{ delta: { content: '好的，' } }] },
      { choices: [{ delta: { content: '我来建' } }] },
      { choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] },
    ]
    const { ctx, body } = setup([
      sse(`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`),
    ])
    const deltas: string[] = []
    ctx.stream = (d) => deltas.push(d.text)
    const result = await bailianProvider.submit(
      {
        capability: 'text.chat',
        model: 'qwen3.7-plus',
        input: {
          messages: [
            { role: 'user', content: '画一张图' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_0', name: 'get_canvas', arguments: {} }],
            },
            {
              role: 'tool',
              toolCallId: 'call_0',
              toolName: 'get_canvas',
              content: '{"elements":[]}',
            },
          ],
          tools: [
            {
              name: 'create_node',
              description: '新建节点',
              parameters: { type: 'object', properties: { type: { type: 'string' } } },
            },
          ],
        },
      },
      ctx,
    )
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [
        { type: 'text', text: '好的，我来建' },
        {
          type: 'tool_calls',
          calls: [{ id: 'call_1', name: 'create_node', arguments: { type: 'plein/image' } }],
        },
      ],
    })
    expect(deltas).toEqual(['好的，', '我来建'])
    const sent = body() as { tools: Array<{ function: { name: string } }>; messages: unknown[] }
    expect(sent.tools[0]!.function.name).toBe('create_node')
    expect(sent.messages).toMatchObject([
      { role: 'user' },
      { role: 'assistant', tool_calls: [{ id: 'call_0', function: { name: 'get_canvas' } }] },
      { role: 'tool', tool_call_id: 'call_0' },
    ])
  })
  it('结构化输出：要求 JSON、Schema 写进系统提示，结果按 Schema 校验', async () => {
    const answer = (content: string) =>
      sse(
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
    const schema = {
      type: 'object',
      properties: { shots: { type: 'integer' } },
      required: ['shots'],
    }
    const { ctx, body } = setup([answer('{"shots":3}'), answer('{"shots":"三"}')])
    const run = () =>
      bailianProvider.submit(
        {
          capability: 'text.chat',
          model: 'qwen3.7-plus',
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: '拆分镜' },
                  { type: 'image', image: { assetId: 'a', kind: 'image' } as never },
                ],
              },
            ],
            jsonSchema: schema,
          },
        },
        ctx,
      )
    expect(await run()).toMatchObject({ outputs: [{ type: 'json', value: { shots: 3 } }] })
    const sent = body()
    expect(sent.response_format).toEqual({ type: 'json_object' })
    expect(sent.messages[0]).toMatchObject({ role: 'system' })
    expect(sent.messages[0].content).toContain('"shots"')
    expect(sent.messages[1].content).toEqual([
      { type: 'text', text: '拆分镜' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    ])
    await expect(run()).rejects.toMatchObject({ code: 'unknown' })
  })
  it('缺少 DONE 时拒绝成功且不会重新提交', async () => {
    const { ctx, fetch } = setup([sse(stream.replace('data: [DONE]\n\n', ''))])
    await expect(
      bailianProvider.submit(
        {
          capability: 'text.chat',
          model: 'qwen3.7-plus',
          input: { messages: [{ role: 'user', content: 'hi' }] },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('图片参考资产编码并解析 native 多图输出', async () => {
    const { ctx, body } = setup([
      {
        output: {
          choices: [
            {
              message: {
                content: [
                  { image: 'https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/a.png' },
                  { image: 'https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/b.png' },
                ],
              },
            },
          ],
        },
        usage: { output_image_count: 2 },
      },
    ])
    const result = await bailianProvider.submit(
      {
        capability: 'image.generate',
        model: 'qwen-image-3.0-pro',
        input: {
          prompt: 'cat',
          width: 1024,
          height: 1024,
          count: 2,
          references: [{ assetId: 'ref', kind: 'image' }],
        },
      },
      ctx,
    )
    expect(result).toMatchObject({ state: 'succeeded', usage: { images: 2 } })
    const sent = body()
    expect(sent.input.messages[0].content[1]).toEqual({ image: 'data:image/png;base64,AQID' })
    expect(sent.parameters).toMatchObject({ size: '1024*1024', n: 2 })
  })
  it('异步视频可跨上下文轮询、取消，未知状态不无限轮询', async () => {
    const { ctx, fetch } = setup([
      { output: { task_id: 'task/1', task_status: 'PENDING' } },
      { output: { task_status: 'RUNNING' } },
      {
        output: {
          task_status: 'SUCCEEDED',
          video_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/v.mp4',
        },
      },
      { output: { task_status: 'CANCELED' } },
      { output: { task_status: 'UNKNOWN' } },
    ])
    expect(
      await bailianProvider.submit(
        {
          capability: 'video.generate',
          model: 'wan3.0-video',
          input: { prompt: 'cat', duration: 5 },
        },
        ctx,
      ),
    ).toMatchObject({ state: 'pending', remoteId: 'task/1' })
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('X-DashScope-Async')).toBe('enable')
    expect(await bailianProvider.poll?.('task/1', { ...ctx })).toMatchObject({ state: 'pending' })
    expect(await bailianProvider.poll?.('task/1', ctx)).toMatchObject({
      state: 'succeeded',
      outputs: [{ kind: 'video' }],
    })
    await bailianProvider.cancel?.('task/1', ctx)
    expect(fetch.mock.calls[3]?.[0]).toMatch(/tasks\/task%2F1\/cancel$/)
    expect(await bailianProvider.poll?.('missing', ctx)).toMatchObject({
      state: 'failed',
      error: { code: 'unknown' },
    })
  })
  it('首尾帧上传 OSS 后启用资源解析请求头', async () => {
    const policy = {
      upload_host: 'https://dashscope.oss-cn-beijing.aliyuncs.com',
      upload_dir: 'tmp',
      oss_access_key_id: 'id',
      signature: 'sig',
      policy: 'policy',
      x_oss_object_acl: 'private',
      x_oss_forbid_overwrite: 'true',
    }
    const { ctx, fetch, body } = setup([{ data: policy }, {}, { output: { task_id: 't' } }])
    await bailianProvider.submit(
      {
        capability: 'video.generate',
        model: 'wan3.0-video',
        input: { prompt: 'cat', firstFrame: { assetId: 'img', kind: 'image' } },
      },
      ctx,
    )
    const sent = body(2)
    expect(sent.input.media[0]).toMatchObject({
      type: 'first_frame',
      url: expect.stringMatching(/^oss:\/\/tmp\//),
    })
    expect(
      new Headers(fetch.mock.calls[2]?.[1]?.headers).get('X-DashScope-OssResourceResolve'),
    ).toBe('enable')
  })
  it('语音 input 指令、音色和业务空间端点符合 native API', async () => {
    const { ctx, fetch, body } = setup([
      {
        output: { audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav' } },
      },
    ])
    ctx.settings.workspaceId = 'work-123'
    const result = await bailianProvider.submit(
      {
        capability: 'audio.speech',
        model: 'qwen3-tts-instruct-flash',
        input: { text: '你好', instruction: '温柔', voice: 'Cherry' },
      },
      ctx,
    )
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [{ kind: 'audio', mime: 'audio/wav' }],
    })
    expect(fetch.mock.calls[0]?.[0]).toContain('work-123.cn-beijing.maas.aliyuncs.com')
    expect(body().input).toMatchObject({
      text: '你好',
      voice: 'Cherry',
      instructions: '温柔',
      optimize_instructions: true,
    })
  })
  it('业务层安全与欠费错误归一化', async () => {
    for (const [code, expected] of [
      ['DataInspectionFailed', 'content_policy'],
      ['Arrearage', 'quota'],
    ]) {
      const { ctx } = setup([{ code, message: 'failed' }])
      await expect(
        bailianProvider.submit(
          { capability: 'audio.speech', model: 'qwen3-tts-flash', input: { text: 'hi' } },
          ctx,
        ),
      ).rejects.toMatchObject({ code: expected })
    }
  })
  it('提交遇 503 / 429 不可重试，轮询遇 503 / 429 可重试', async () => {
    for (const status of [503, 429]) {
      const busy = () => Response.json({ code: 'Throttling', message: 'busy' }, { status })
      const { ctx } = setup([busy(), busy()])
      await expect(
        bailianProvider.submit(
          { capability: 'audio.speech', model: 'qwen3-tts-flash', input: { text: 'hi' } },
          ctx,
        ),
      ).rejects.toMatchObject({ retryable: false })
      await expect(bailianProvider.poll!('t', ctx)).rejects.toMatchObject({ retryable: true })
    }
  })
  it('核心图片节点 aspectRatio 映射官方 size，显式 size 优先且不透传未知字段', async () => {
    for (const model of ['qwen-image-3.0-pro', 'wan2.7-image-pro']) {
      for (const [extra, expected] of [
        [{ aspectRatio: '9:16', unknown: true }, '936*1664'],
        [{ aspectRatio: '16:9', size: '1024*1024' }, '1024*1024'],
        [{}, '1664*936'],
      ] as const) {
        const { ctx, body } = setup([
          {
            output: {
              choices: [
                {
                  message: {
                    content: [
                      { image: 'https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/a.png' },
                    ],
                  },
                },
              ],
            },
          },
        ])
        await bailianProvider.submit(
          { capability: 'image.generate', model, input: { prompt: 'cat', extra } },
          ctx,
        )
        const sent = body()
        expect(sent.parameters.size).toBe(expected)
        expect(sent.parameters).not.toHaveProperty('aspectRatio')
        expect(sent.parameters).not.toHaveProperty('unknown')
      }
    }
  })
  it('HTTP、SSE 与异步失败均脱敏密钥', async () => {
    const sensitive = 'sk-test'
    const { ctx } = setup([
      sse(`data: {"error":{"code":"InvalidApiKey","message":"invalid ${sensitive}"}}\n\n`),
      { output: { task_status: 'FAILED', code: 'InvalidApiKey', message: `invalid ${sensitive}` } },
      Response.json(
        { error: { code: 'InvalidApiKey', message: `invalid ${sensitive}` } },
        { status: 401 },
      ),
    ])
    await expect(
      bailianProvider.submit(
        {
          capability: 'text.chat',
          model: 'qwen3.7-plus',
          input: { messages: [{ role: 'user', content: 'hi' }] },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ message: 'invalid [REDACTED]' })
    expect(await bailianProvider.poll?.('t', ctx)).toMatchObject({
      state: 'failed',
      error: { message: 'invalid [REDACTED]' },
    })
    await expect(
      bailianProvider.submit(
        { capability: 'audio.speech', model: 'qwen3-tts-flash', input: { text: 'hi' } },
        ctx,
      ),
    ).rejects.toMatchObject({ message: 'invalid [REDACTED]' })
  })
})

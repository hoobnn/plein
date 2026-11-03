import { describe, expect, it } from 'vite-plus/test'
import sharp from 'sharp'
import { fakeContext, sse } from '../testing'
import { openaiPlugin, openaiProvider } from './index'
import type { CapabilityInput, ChatMessage } from '@plein/plugin-sdk'

const imageReply = { data: [{ b64_json: 'AQID' }] }
const textResponse = (terminal = true, text = 'hello') =>
  sse(
    [
      {
        type: 'response.created',
        response: { id: 'resp_1', created_at: 1, model: 'gpt-6.1-sol', status: 'in_progress' },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      ...(terminal
        ? [
            {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                created_at: 1,
                model: 'gpt-6.1-sol',
                status: 'completed',
                output: [],
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
              },
            },
          ]
        : []),
    ]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`)
      .join(''),
  )
const chat = (
  f: ReturnType<typeof fakeContext<Record<string, never>>>,
  input: Partial<CapabilityInput<'text.chat'>> = {},
) =>
  openaiProvider.submit(
    {
      capability: 'text.chat',
      model: 'gpt-6.1-sol',
      input: { messages: [{ role: 'user', content: 'hi' }], ...input },
    },
    f.ctx,
  )
const image = (
  f: ReturnType<typeof fakeContext<Record<string, never>>>,
  input: Partial<CapabilityInput<'image.generate'>> = {},
) =>
  openaiProvider.submit(
    {
      capability: 'image.generate',
      model: 'gpt-image-2.5-sunburst',
      input: { prompt: 'test', ...input },
    },
    f.ctx,
  )

describe('OpenAI 官方平台', () => {
  it('只申请官方 API 域名、自身密钥和只读资产', () => {
    expect(openaiPlugin.plugin.manifest.permissions).toEqual({
      network: ['api.openai.com'],
      secrets: ['OPENAI_API_KEY'],
      assets: 'read',
      media: false,
    })
    expect(openaiProvider.remoteModelsScope).toEqual([])
  })
  it('对话模型声明不支持调温，让宿主在运行前就隐藏并说明', () => {
    for (const spec of openaiProvider.models)
      if (spec.capabilities.includes('text.chat')) expect(spec.limits?.temperature).toBe(false)
    for (const spec of openaiProvider.models)
      if (!spec.capabilities.includes('text.chat')) expect(spec.limits?.temperature).toBeUndefined()
  })
  it('连接检查只读模型列表，目录外模型不假定可对话', async () => {
    const f = fakeContext(openaiProvider, [{ data: [{ id: 'whisper-1' }, { id: 'gpt-6.1-sol' }] }])
    expect(await openaiProvider.listRemoteModels!(f.ctx)).toEqual([
      { id: 'whisper-1' },
      { id: 'gpt-6.1-sol' },
    ])
    expect(f.fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models')
    expect(f.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer test-secret' },
    })
  })
  it('流式 Responses 回答归一化文本与用量，避免发送推理模型不支持的温度', async () => {
    const f = fakeContext(openaiProvider, [textResponse()])
    expect(await chat(f, { temperature: 0.7, maxTokens: 300 })).toMatchObject({
      state: 'succeeded',
      outputs: [{ type: 'text', text: 'hello' }],
      usage: { inputTokens: 4, outputTokens: 2 },
    })
    expect(f.fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses')
    expect(f.body()).toMatchObject({
      model: 'gpt-6.1-sol',
      stream: true,
      store: false,
      max_output_tokens: 300,
      include: ['reasoning.encrypted_content'],
    })
    expect(f.body()).not.toHaveProperty('temperature')
  })
  it('结构化输出发送 JSON Schema 并返回经验证的 JSON', async () => {
    const f = fakeContext(openaiProvider, [textResponse(true, '{"ok":true}')])
    const result = await chat(f, {
      jsonSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    })
    expect(result).toMatchObject({
      state: 'succeeded',
      outputs: [{ type: 'json', value: { ok: true } }],
    })
    expect(f.body().text.format).toMatchObject({ type: 'json_schema', strict: true })
  })
  it('对话图片编码成 Responses input_image，不混用 Chat Completions 字段', async () => {
    const f = fakeContext(openaiProvider, [textResponse()])
    await chat(f, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', image: { assetId: 'a', kind: 'image' } },
          ],
        },
      ],
    })
    expect(f.body().input[0].content).toContainEqual(
      expect.objectContaining({ type: 'input_image', image_url: 'data:image/png;base64,AQID' }),
    )
    expect(f.body()).not.toHaveProperty('messages')
  })
  it('回答截断保留提交未知，且不重复发送', async () => {
    const f = fakeContext(openaiProvider, [textResponse(false)])
    await expect(chat(f)).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it('同模型的工具续轮回传加密思考，切换模型后不传', async () => {
    for (const model of ['gpt-6.1-sol', 'other']) {
      const f = fakeContext(openaiProvider, [textResponse()])
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          continuation: { model, encryptedContent: 'encrypted' },
          toolCalls: [{ id: 'call1', name: 'read', arguments: {} }],
        },
        { role: 'tool', content: 'result', toolCallId: 'call1', toolName: 'read' },
      ]
      await chat(f, { messages })
      expect(
        f
          .body()
          .input.some((p: { encrypted_content?: string }) => p.encrypted_content === 'encrypted'),
      ).toBe(model === 'gpt-6.1-sol')
    }
  })
  it('工具调用和加密思考结果返回宿主供下一轮使用', async () => {
    const frames = [
      { type: 'response.created', response: { id: 'r1', created_at: 1, model: 'gpt-6.1-sol' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'rs1', type: 'reasoning', summary: [], encrypted_content: 'encrypted' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'rs1', type: 'reasoning', summary: [], encrypted_content: 'encrypted' },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'read', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc1',
        output_index: 1,
        delta: '{}',
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'fc1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call1',
          name: 'read',
          arguments: '{}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'r1',
          created_at: 1,
          model: 'gpt-6.1-sol',
          status: 'completed',
          output: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ]
    const f = fakeContext(openaiProvider, [
      sse(frames.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')),
    ])
    expect(
      await chat(f, {
        tools: [
          {
            name: 'read',
            description: 'read',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      }),
    ).toMatchObject({
      outputs: [
        {
          type: 'tool_calls',
          calls: [{ id: 'call1', name: 'read', arguments: {} }],
          continuation: { model: 'gpt-6.1-sol', encryptedContent: 'encrypted' },
        },
      ],
    })
  })
  it('无参考时发送生成，固定画幅按像素映射且不透传多余字段', async () => {
    const f = fakeContext(openaiProvider, [imageReply])
    expect(
      await image(f, { extra: { aspectRatio: '16:9', quality: 'high', model: 'injected' } }),
    ).toMatchObject({
      outputs: [{ type: 'file', mime: 'image/png', data: Buffer.from([1, 2, 3]) }],
    })
    expect(f.fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/images/generations')
    expect(f.body()).toEqual({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'test',
      quality: 'high',
      output_format: 'png',
      n: 1,
      size: '1536x864',
    })
  })
  it('有参考发送原生编辑 JSON，支持多参考，格式与结果 MIME 一致', async () => {
    const f = fakeContext(openaiProvider, [imageReply])
    expect(
      await image(f, {
        references: [
          { assetId: 'a', kind: 'image' },
          { assetId: 'b', kind: 'image' },
        ],
        extra: { output_format: 'webp' },
      }),
    ).toMatchObject({ outputs: [{ mime: 'image/webp' }] })
    expect(f.fetch.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/images/edits')
    expect(f.body().images).toEqual([
      { image_url: 'data:image/png;base64,AQID' },
      { image_url: 'data:image/png;base64,AQID' },
    ])
  })
  it('蒙版白色转换为透明，黑色转换为不透明，原图转 PNG 且尺寸一致', async () => {
    const f = fakeContext(openaiProvider, [imageReply])
    const original = await sharp({
      create: { width: 2, height: 1, channels: 3, background: 'red' },
    })
      .jpeg()
      .toBuffer()
    const mask = await sharp(Buffer.from([0, 255]), { raw: { width: 2, height: 1, channels: 1 } })
      .png()
      .toBuffer()
    f.ctx.files.read = async (ref) => ({
      data: ref.assetId === 'source' ? original : mask,
      mime: 'image/png',
    })
    await openaiProvider.submit(
      {
        capability: 'image.edit',
        model: 'gpt-image-2.5-flare',
        input: {
          prompt: 'edit',
          image: { assetId: 'source', kind: 'image' },
          mask: { assetId: 'mask', kind: 'image' },
        },
      },
      f.ctx,
    )
    const converted = Buffer.from(f.body().mask.image_url.split(',')[1], 'base64')
    const pixels = await sharp(converted).raw().toBuffer()
    expect([pixels[3], pixels[7]]).toEqual([255, 0])
    expect(f.body().images[0].image_url).toMatch(/^data:image\/png;base64,/)
  })
  it.each([
    { count: 11 },
    { count: 0 },
    { width: 1000, height: 1000 },
    { references: Array.from({ length: 17 }, () => ({ assetId: 'a', kind: 'image' as const })) },
    { extra: { output_format: 'jpeg', background: 'transparent' } },
    { extra: { aspectRatio: '21:9' } },
  ])('非法图片参数在联网前拒绝 %j', async (input) => {
    const f = fakeContext(openaiProvider)
    await expect(image(f, input)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([
    [401, 'invalid_api_key', 'auth'],
    [429, 'insufficient_quota', 'quota'],
    [429, 'rate_limit_exceeded', 'rate_limit'],
    [400, 'content_policy_violation', 'content_policy'],
    [503, 'server_error', 'unavailable'],
  ] as const)('HTTP %s 归类错误且密钥脱敏', async (status, code, category) => {
    const f = fakeContext(openaiProvider, [
      Response.json({ error: { code, message: 'bad test-secret' } }, { status }),
    ])
    await expect(image(f)).rejects.toMatchObject({
      code: category,
      message: 'bad [redacted]',
      retryable: false,
      ...(status >= 500 ? { outcome: 'unknown' } : {}),
    })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it('响应解析失败和网络失败保留提交未知', async () => {
    for (const reply of [{ data: [] }, new TypeError('network')]) {
      const f = fakeContext(openaiProvider, [reply])
      await expect(image(f)).rejects.toMatchObject({ outcome: 'unknown', retryable: false })
      expect(f.fetch).toHaveBeenCalledTimes(1)
    }
  })
})

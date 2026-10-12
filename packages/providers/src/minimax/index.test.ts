import { domainAllowed, type AssetRef, type ProviderContext } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vitest'
import { minimaxPlugin, minimaxProvider } from './index'

function setup(responses: unknown[] = []) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next instanceof Response ? next : Response.json(next)
  })
  const ctx: ProviderContext<ReturnType<typeof minimaxProvider.settings.parse>> = {
    settings: minimaxProvider.settings.parse({}),
    secret: () => 'test-key',
    fetch: fetcher as typeof fetch,
    signal: new AbortController().signal,
    log: vi.fn(),
    files: { read: vi.fn(async () => ({ data: new Uint8Array([1, 2, 3]), mime: 'image/png' })) },
  }
  return {
    ctx,
    fetcher,
    body: (index = 0) =>
      JSON.parse((fetcher.mock.calls[index] as unknown as [string, RequestInit])[1].body as string),
  }
}
const frame: AssetRef = { assetId: 'frame', kind: 'image', mime: 'image/png' }

describe('MiniMax 官方 HTTP 契约', () => {
  it('allows the actual image-result OSS domain and recognizes withdrawn music access', async () => {
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
  it('声明地区、凭据和资产权限', () => {
    expect(minimaxProvider.settings.parse({})).toMatchObject({ region: 'cn' })
    expect(minimaxPlugin.plugin.manifest.permissions).toMatchObject({
      assets: 'read',
      secrets: ['MINIMAX_API_KEY'],
    })
  })
  it('连接测试只 GET models，不触发生成', async () => {
    const { ctx, fetcher } = setup([{ data: [] }])
    await minimaxProvider.test!(ctx)
    expect(fetcher).toHaveBeenCalledWith(
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
        model: 'MiniMax-M3',
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
  it('M2.7 拒绝图片，在计费请求前失败', async () => {
    const { ctx, fetcher } = setup()
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
    expect(fetcher).not.toHaveBeenCalled()
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
    const { ctx, body, fetcher } = setup([{ task_id: 'task-1' }])
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
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.minimax.cn/v2/video_generation')
    expect(body()).toMatchObject({
      resolution: '2K',
      ratio: 'adaptive',
      content: [{ type: 'text', text: '跳舞' }, { role: 'first_frame' }, { role: 'last_frame' }],
    })
    expect(result).toMatchObject({ state: 'pending', remoteId: 'task-1' })
  })
  it('H3-Max 不支持 2K，在提交前失败', async () => {
    const { ctx, fetcher } = setup()
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
    expect(fetcher).not.toHaveBeenCalled()
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
    const { ctx, fetcher } = setup([{ task: { id: 't1', status: 'succeeded' } }])
    await minimaxProvider.cancel!('t1', ctx)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const queued = setup([{ task: { id: 't2', status: 'queued' } }, {}])
    await minimaxProvider.cancel!('t2', queued.ctx)
    expect(queued.fetcher).toHaveBeenLastCalledWith(
      'https://api.minimax.cn/v2/video_generation/t2',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
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
    ).rejects.toMatchObject({
      code: 'quota',
      message: 'MiniMax：balance [redacted]',
      retryable: false,
    })
  })
  it('未知提交不自动重试，也不虚构 task ID', async () => {
    const { ctx, fetcher } = setup([new Error('disconnect')])
    await expect(
      minimaxProvider.submit(
        { capability: 'video.generate', model: 'MiniMax-H3', input: { prompt: '跳舞' } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', retryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

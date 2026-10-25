import { describe, expect, it, vi } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { arkProvider } from './index'

// https://docs.volcengine.com/docs/ark/image-generation-api?lang=en
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
const model = 'doubao-seedream-5-0-pro-260628'
const v25 = 'doubao-seedance-2-5-260628'
const v20 = 'doubao-seedance-2-0-260128'
const image = { assetId: 'source', kind: 'image' as const }
const audio = { assetId: 'voice', kind: 'audio' as const }
const video = { assetId: 'motion', kind: 'video' as const }
const setup = (replies: unknown[] = [], over = {}) => {
  const f = fakeContext(arkProvider, replies)
  f.ctx.files.read = vi.fn(async (ref) => ({
    data: new Uint8Array([1, 2, 3]),
    mime: ref.kind === 'audio' ? 'audio/wav' : ref.kind === 'video' ? 'video/mp4' : 'image/png',
    width: 1024,
    height: 1024,
    duration: 4,
    videoCodec: 'h264',
    frameRate: 30,
    audioCodecs: [],
    ...over,
  }))
  return f
}

describe('Ark 创作扩展 HTTP 合同', () => {
  it('Seedance 2.5 允许纯音频且保留用途；2.0 需要图片或视频搭配', async () => {
    const f = setup([{ id: 'r1' }])
    expect(
      await arkProvider.submit(
        {
          capability: 'video.generate',
          model: v25,
          input: { prompt: '按音乐设计画面', references: [audio] },
        },
        f.ctx,
      ),
    ).toMatchObject({ state: 'pending', remoteId: 'r1' })
    expect(f.body().content).toEqual([
      { type: 'text', text: '按音乐设计画面' },
      {
        type: 'audio_url',
        audio_url: { url: 'data:audio/wav;base64,AQID' },
        role: 'reference_audio',
      },
    ])
    const old = setup()
    await expect(
      arkProvider.submit(
        {
          capability: 'video.generate',
          model: v20,
          input: { prompt: '跳舞', references: [audio] },
        },
        old.ctx,
      ),
    ).rejects.toThrow('搭配图片或视频')
    expect(old.fetch).not.toHaveBeenCalled()
  })
  it('本地视频声明实际上限；缺少 TOS 配置时不发送生成请求', async () => {
    const f = setup()
    for (const model of [v25, v20]) {
      expect(arkProvider.models.find((m) => m.id === model)?.limits?.referenceMedia?.video).toBe(
        model === v25 ? 10 : 3,
      )
      await expect(
        arkProvider.submit(
          { capability: 'video.generate', model, input: { prompt: '运动', references: [video] } },
          f.ctx,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('首尾帧各自合法但编码后总请求超过 64 MiB 时在 HTTP 前拒绝', async () => {
    const f = setup([], { data: new Uint8Array(25 * 1024 * 1024) })
    await expect(
      arkProvider.submit(
        {
          capability: 'video.generate',
          model: v25,
          input: { prompt: '缓慢运动', firstFrame: image, lastFrame: image },
        },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('只把 z_index > 0 的透明 PNG 图层输出为候选，底图仍留在图层元数据', async () => {
    const f = setup([
      {
        data: [
          { z_index: 0, b64_json: 'AQID', output_format: 'jpeg' },
          {
            z_index: 1,
            b64_json: 'BAUG',
            name: '人物',
            bounding_box: { absolute: [0, 0, 32, 64] },
          },
          { z_index: 2, url: 'https://result.tos-cn-beijing.volces.com/logo.png', name: '文字' },
        ],
      },
    ])
    const out = await arkProvider.submit(
      {
        capability: 'image.process',
        model,
        input: { image, operation: 'cutout', prompt: '拆出人物' },
      },
      f.ctx,
    )
    expect(f.body()).toMatchObject({
      model,
      image: 'data:image/png;base64,AQID',
      layer_decomposition: true,
      output_format: 'png',
      response_format: 'b64_json',
    })
    expect(out).toMatchObject({
      state: 'succeeded',
      outputs: [
        {
          type: 'file',
          kind: 'image',
          mime: 'image/png',
          data: new Uint8Array([4, 5, 6]),
          name: '人物.png',
        },
        {
          type: 'file',
          kind: 'image',
          mime: 'image/png',
          url: 'https://result.tos-cn-beijing.volces.com/logo.png',
        },
        {
          type: 'json',
          value: {
            layers: [{ z_index: 0 }, { z_index: 1, name: '人物' }, { z_index: 2, name: '文字' }],
          },
        },
      ],
    })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { mime: 'image/webp' },
    { width: 200, height: 200 },
    { width: NaN },
    { height: Infinity },
    { data: new Uint8Array() },
  ])('抠图原图约束在 HTTP 之前验证 %j', async (over) => {
    const f = setup([], over)
    await expect(
      arkProvider.submit(
        { capability: 'image.process', model, input: { image, operation: 'cutout' } },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([
    { data: [{ z_index: 0, b64_json: 'AQID' }] },
    { data: [{ z_index: 1, b64_json: 'not base64 !' }] },
    { data: [{ z_index: 1.5, b64_json: 'AQID' }] },
    { data: [{ z_index: 1, b64_json: 'A' }] },
    { data: [{ z_index: 1, b64_json: 'AQID', bounding_box: { absolute: [0, 1, 'bad', 3] } }] },
    {
      data: [
        { z_index: 1, b64_json: 'AQID' },
        { z_index: 1, b64_json: 'AQID' },
      ],
    },
    {},
  ])('缺失或无效图层保持 unknown，绝不自动重提 %j', async (reply) => {
    const f = setup([reply])
    await expect(
      arkProvider.submit(
        { capability: 'image.process', model, input: { image, operation: 'cutout' } },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown' })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
})

const withStorage = (replies: unknown[], over = {}) => {
  const f = setup(replies, over)
  f.ctx.settings.referenceBucket = 'test-bucket'
  return f
}

describe('Seedance 多模态通路与任务类型', () => {
  it.each([v25, v20, 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini-260615'])(
    '三类素材上传和引用编号：%s',
    async (model) => {
      const f = withStorage([new Response(null, { status: 200 }), { id: 'accepted' }])
      await expect(
        arkProvider.submit(
          {
            capability: 'video.generate',
            model,
            input: {
              prompt: '@图片1 参考 @video1 运镜和 @audio1',
              references: [image, video, audio],
            },
          },
          f.ctx,
        ),
      ).resolves.toMatchObject({ remoteId: 'accepted' })
      expect(f.fetch).toHaveBeenCalledTimes(2)
      const body = f.body(1)
      expect(body.content.map((v: { role: string }) => v.role)).toEqual([
        undefined,
        'reference_image',
        'reference_video',
        'reference_audio',
      ])
      expect(body.content[0].text).toBe('@image1 参考 @video1 运镜和 @audio1')
      expect(body.content[2].video_url.url).toMatch(
        /^https:\/\/test-bucket\.tos-cn-beijing\.volces\.com\//,
      )
      expect(body.content[2].video_url.url).not.toContain('data:')
      expect(f.fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
        Authorization: 'Bearer test-secret',
      })
    },
  )
  it.each(['edit', 'extend'])('%s 自动对齐画幅和时长', async (task) => {
    const f = withStorage([new Response(null, { status: 200 }), { id: 'task' }])
    await arkProvider.submit(
      {
        capability: 'video.generate',
        model: v25,
        input: {
          prompt: task === 'edit' ? '替换 @video1 的背景' : '向后延长 @video1',
          references: [video],
          aspectRatio: '16:9',
          duration: 5,
          extra: { omni_reference_task_type: task },
        },
      },
      f.ctx,
    )
    expect(f.body(1)).toMatchObject({
      ratio: 'adaptive',
      duration: task === 'edit' ? -1 : 5,
      omni_reference_task_type: task,
    })
  })
  it('编辑短视频、越界引用、累计超限和缺失素材均不上传或生成', async () => {
    for (const input of [
      { prompt: '编辑', references: [video], extra: { omni_reference_task_type: 'edit' } },
      { prompt: '@video2', references: [video] },
      {
        prompt: 'p',
        references: [video, video, video, video, video, video, video, video, video, video, video],
      },
      { prompt: 'p', extra: { omni_reference_task_type: 'extend' } },
    ]) {
      const f = withStorage([], { duration: 3 })
      await expect(
        arkProvider.submit({ capability: 'video.generate', model: v25, input }, f.ctx),
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(f.fetch).not.toHaveBeenCalled()
    }
    const f = withStorage([], { duration: 16 })
    await expect(
      arkProvider.submit(
        {
          capability: 'video.generate',
          model: v25,
          input: { prompt: 'p', references: [video, video] },
        },
        f.ctx,
      ),
    ).rejects.toThrow('总时长')
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('有参考时允许空提示词，自动时长不透传内部开关', async () => {
    const f = setup([{ id: 'task' }])
    await arkProvider.submit(
      {
        capability: 'video.generate',
        model: v20,
        input: { prompt: '', references: [image], extra: { adaptive_duration: true } },
      },
      f.ctx,
    )
    expect(f.body().content).toHaveLength(1)
    expect(f.body().duration).toBe(-1)
    expect(f.body()).not.toHaveProperty('adaptive_duration')
  })
  it('TOS 上传网络失败不发送生成请求，不标记生成结果未知', async () => {
    const f = withStorage([new Error('secret signed URL')])
    await expect(
      arkProvider.submit(
        { capability: 'video.generate', model: v25, input: { prompt: 'p', references: [video] } },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'unavailable', outcome: undefined })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
})

it('Seedance 2.5 首帧 / 首尾帧忽略节点默认画幅，统一保持输入比例', async () => {
  const f = setup([{ id: 'first' }, { id: 'both' }])
  for (const lastFrame of [undefined, image]) {
    await arkProvider.submit(
      {
        capability: 'video.generate',
        model: v25,
        input: { prompt: '镜头移动', firstFrame: image, lastFrame, aspectRatio: '16:9' },
      },
      f.ctx,
    )
  }
  expect(f.body(0).ratio).toBe('adaptive')
  expect(f.body(1).ratio).toBe('adaptive')
})

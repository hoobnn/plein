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
  it('本地视频不发错误 data URL；模型目录也不声称这条本地通路可用', async () => {
    const f = setup()
    for (const model of [v25, v20]) {
      expect(arkProvider.models.find((m) => m.id === model)?.limits?.referenceMedia?.video).toBe(0)
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

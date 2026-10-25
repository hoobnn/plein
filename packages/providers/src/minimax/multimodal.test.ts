import type { CapabilityInput } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { minimaxProvider } from './index'

// https://platform.minimax.io/docs/api-reference/video-generation-v2-create
const image = { assetId: 'image', kind: 'image' as const }
const video = { assetId: 'video', kind: 'video' as const }
const audio = { assetId: 'audio', kind: 'audio' as const }
const setup = (replies: unknown[] = [], over = {}) => {
  const f = fakeContext(minimaxProvider, replies)
  f.ctx.files.read = vi.fn(async (ref) => ({
    data: new Uint8Array([1, 2, 3]),
    mime: ref.kind === 'audio' ? 'audio/wav' : ref.kind === 'video' ? 'video/mp4' : 'image/png',
    width: 1024,
    height: 1024,
    duration: 5,
    videoCodec: 'h264',
    frameRate: 30,
    audioCodecs: [],
    ...over,
  }))
  return f
}

describe('MiniMax H3 多模态 HTTP 合同', () => {
  it('图片、视频、音频按输入顺序送入 V2 content；纯音频参考也可提交', async () => {
    const f = setup([{ task_id: 'r1' }, { task_id: 'r2' }])
    const result = await minimaxProvider.submit(
      {
        capability: 'video.generate',
        model: 'MiniMax-H3',
        input: { prompt: '参考运镜和声音', references: [video, image, audio] },
      },
      f.ctx,
    )
    expect(result).toMatchObject({ state: 'pending', remoteId: 'r1' })
    expect(f.fetch.mock.calls[0]?.[0]).toBe('https://api.minimax.cn/v2/video_generation')
    expect(f.body().content).toEqual([
      { type: 'text', text: '参考运镜和声音' },
      {
        type: 'video_url',
        video_url: { url: 'data:video/mp4;base64,AQID' },
        role: 'reference_video',
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AQID' },
        role: 'reference_image',
      },
      {
        type: 'audio_url',
        audio_url: { url: 'data:audio/wav;base64,AQID' },
        role: 'reference_audio',
      },
    ])
    await expect(
      minimaxProvider.submit(
        {
          capability: 'video.generate',
          model: 'MiniMax-H3-Max',
          input: { prompt: '跟着节拍', references: [audio] },
        },
        f.ctx,
      ),
    ).resolves.toMatchObject({ remoteId: 'r2' })
  })
  it('首尾帧与多模态参考不混用；超过数量、总时长和无效尺寸先拒绝', async () => {
    const f = setup()
    for (const input of [
      { prompt: 'p', firstFrame: image, references: [video] },
      { prompt: 'p', references: [video, video, video, video] },
    ]) {
      await expect(
        minimaxProvider.submit({ capability: 'video.generate', model: 'MiniMax-H3', input }, f.ctx),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    const invalid = setup([], { duration: NaN })
    await expect(
      minimaxProvider.submit(
        {
          capability: 'video.generate',
          model: 'MiniMax-H3',
          input: { prompt: 'p', references: [video] },
        },
        invalid.ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(invalid.fetch).not.toHaveBeenCalled()
  })
  it('提交缺回执时不重新发出付费请求', async () => {
    const f = setup([{}])
    await expect(
      minimaxProvider.submit(
        {
          capability: 'video.generate',
          model: 'MiniMax-H3',
          input: { prompt: 'p', references: [audio] },
        },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown', retryable: false })
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
})

const scenes: Array<[string, Partial<CapabilityInput<'video.generate'>>, string[]]> = [
  ['text', {}, []],
  ['first frame', { firstFrame: image }, ['first_frame']],
  ['last frame', { lastFrame: image }, ['last_frame']],
  ['first and last', { firstFrame: image, lastFrame: image }, ['first_frame', 'last_frame']],
  ...Array.from(
    { length: 7 },
    (_, i): [string, Partial<CapabilityInput<'video.generate'>>, string[]] => {
      const references = [image, video, audio].filter((_, bit) => (i + 1) & (1 << bit))
      return [
        references.map((r) => r.kind).join('+'),
        { references },
        references.map((r) => `reference_${r.kind}`),
      ]
    },
  ),
]
for (const model of ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max']) {
  describe(`${model} 所有输入组合`, () => {
    it.each(scenes)('%s', async (_, media, roles) => {
      const f = setup([{ task_id: 'matrix-task' }])
      await expect(
        minimaxProvider.submit(
          { capability: 'video.generate', model, input: { prompt: '镜头缓慢移动', ...media } },
          f.ctx,
        ),
      ).resolves.toMatchObject({ state: 'pending', remoteId: 'matrix-task' })
      const content = f.body().content
      expect(content[0]).toEqual({ type: 'text', text: '镜头缓慢移动' })
      expect(content.slice(1).map((item: { role: string }) => item.role)).toEqual(roles)
      expect(content.slice(1).map((item: { type: string }) => item.type)).toEqual(
        roles.map(
          (role) =>
            `${role === 'reference_video' ? 'video' : role === 'reference_audio' ? 'audio' : 'image'}_url`,
        ),
      )
      expect(f.body().ratio).toBe(media.firstFrame || media.lastFrame ? 'adaptive' : '16:9')
      expect(f.fetch).toHaveBeenCalledOnce()
    })
  })
}

describe('MiniMax 提交前素材检查', () => {
  it.each(['', '   ', '\n\t'])('空提示词 %j 不发送请求', async (prompt) => {
    const f = setup()
    await expect(
      minimaxProvider.submit(
        { capability: 'video.generate', model: 'MiniMax-H3', input: { prompt, lastFrame: image } },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.ctx.files.read).not.toHaveBeenCalled()
  })
  for (const field of ['firstFrame', 'lastFrame'] as const) {
    it.each([
      { width: undefined },
      { height: NaN },
      { width: 255 },
      { height: 5761 },
      { width: 256, height: 1024 },
      { width: 1024, height: 256 },
      { mime: 'image/gif' },
      { data: new Uint8Array() },
      { data: new Uint8Array(30 * 1024 * 1024 + 1) },
    ])(`${field} 拒绝非法素材 %#`, async (over) => {
      const f = setup([], over)
      await expect(
        minimaxProvider.submit(
          {
            capability: 'video.generate',
            model: 'MiniMax-H3',
            input: { prompt: 'p', [field]: image },
          },
          f.ctx,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(f.fetch).not.toHaveBeenCalled()
    })
    it(`${field} 拒绝非图片和参考混用`, async () => {
      const f = setup()
      for (const input of [
        { prompt: 'p', [field]: video },
        { prompt: 'p', [field]: image, references: [audio] },
      ]) {
        await expect(
          minimaxProvider.submit(
            { capability: 'video.generate', model: 'MiniMax-H3', input },
            f.ctx,
          ),
        ).rejects.toMatchObject({ code: 'invalid_input' })
      }
      expect(f.fetch).not.toHaveBeenCalled()
    })
    it.each([
      { width: 256, height: 640 },
      { width: 640, height: 256 },
      { width: 5760, height: 5760 },
    ])(`${field} 接受尺寸比例边界 %j`, async (over) => {
      const f = setup([{ task_id: 'edge' }], over)
      await expect(
        minimaxProvider.submit(
          {
            capability: 'video.generate',
            model: 'MiniMax-H3',
            input: { prompt: 'p', [field]: image },
          },
          f.ctx,
        ),
      ).resolves.toMatchObject({ remoteId: 'edge' })
    })
  }
  it.each([
    { videoCodec: undefined },
    { videoCodec: 'vp9' },
    { frameRate: undefined },
    { frameRate: NaN },
    { frameRate: Infinity },
    { frameRate: 23.975 },
    { frameRate: 60.001 },
    { audioCodecs: undefined },
    { audioCodecs: ['opus'] },
    { audioCodecs: ['aac', 'unknown'] },
  ])('拒绝不合规视频属性 %j', async (over) => {
    const f = setup([], over)
    await expect(
      minimaxProvider.submit(
        {
          capability: 'video.generate',
          model: 'MiniMax-H3',
          input: { prompt: 'p', references: [video] },
        },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([
    { videoCodec: 'h264', frameRate: 23.976, audioCodecs: [] },
    { videoCodec: 'hevc', frameRate: 24000 / 1001, audioCodecs: ['aac'] },
    { videoCodec: 'h264', frameRate: 60, audioCodecs: ['aac', 'mp3'] },
  ])('接受合规视频属性 %j', async (over) => {
    const f = setup([{ task_id: 'valid-video' }], over)
    await expect(
      minimaxProvider.submit(
        {
          capability: 'video.generate',
          model: 'MiniMax-H3',
          input: { prompt: 'p', references: [video] },
        },
        f.ctx,
      ),
    ).resolves.toMatchObject({ remoteId: 'valid-video' })
  })
})

describe('H3 模型与参考画幅对齐', () => {
  it.each(['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Max'])(
    '%s 参考支持自动与超宽画幅',
    async (model) => {
      for (const aspectRatio of ['auto', '21:9']) {
        const f = setup([{ task_id: 'task' }])
        await minimaxProvider.submit(
          {
            capability: 'video.generate',
            model,
            input: { prompt: '参考 @video1 与 @音频1', references: [video, audio], aspectRatio },
          },
          f.ctx,
        )
        expect(f.body()).toMatchObject({
          ratio: aspectRatio === 'auto' ? 'adaptive' : '21:9',
          content: [
            { type: 'text', text: '参考 视频1 与 音频1' },
            expect.anything(),
            expect.anything(),
          ],
        })
      }
    },
  )
  it('非法画幅、Lite 自动画幅、Highspeed 2K、引用越界不联网', async () => {
    for (const [model, input] of [
      ['MiniMax-H3', { aspectRatio: '3:2' }],
      ['MiniMax-H3', { aspectRatio: 'auto' }],
      ['MiniMax-H3-Lite', { aspectRatio: 'auto', references: [image] }],
      ['MiniMax-H3-Highspeed', { resolution: '2K' }],
      ['MiniMax-H3', { prompt: '@image2', references: [image] }],
    ] as const) {
      const f = setup()
      await expect(
        minimaxProvider.submit(
          {
            capability: 'video.generate',
            model,
            input: {
              prompt: 'p',
              ...input,
              ...('references' in input ? { references: [...input.references] } : {}),
            },
          },
          f.ctx,
        ),
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(f.fetch).not.toHaveBeenCalled()
    }
  })
})

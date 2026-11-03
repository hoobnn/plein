import type { AssetRef, MediaRequirements } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { videoReferences } from './video-references'

// https://platform.minimax.io/docs/api-reference/video-generation-v2-create
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
const ref = (kind: AssetRef['kind'], assetId: string = kind): AssetRef => ({ kind, assetId })
const limits = { image: 9, video: 3, audio: 3, allowAudioOnly: true } as const
const context = (over = {}) => ({
  files: {
    read: vi.fn(async (value: AssetRef) => ({
      data: new Uint8Array([1, 2, 3]),
      mime:
        value.kind === 'image' ? 'image/png' : value.kind === 'video' ? 'video/mp4' : 'audio/x-wav',
      width: 1024,
      height: 1024,
      duration: 5,
      ...over,
    })),
  },
})

describe('本地多模态参考输入合同', () => {
  it('保留显式输入顺序和用途，通过宿主读取并编码，WAV MIME 正规化', async () => {
    const ctx = context()
    const content = await videoReferences([ref('video'), ref('image'), ref('audio')], ctx, limits)
    expect(content).toEqual([
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
    expect(ctx.files.read.mock.calls.map(([value]) => value.assetId)).toEqual([
      'video',
      'image',
      'audio',
    ])
  })
  it.each(['audio/mpeg', 'audio/mp3'])('MP3 参考音频（%s）按 mp3 格式编码', async (mime) => {
    for (const platform of ['ark', 'minimax'] as const) {
      const content = await videoReferences([ref('image'), ref('audio')], context(), {
        ...limits,
        platform,
      })
      expect(content[1]).toMatchObject({ audio_url: { url: 'data:audio/mp3;base64,AQID' } })
    }
    function context() {
      return {
        files: {
          read: vi.fn(async (value: AssetRef) =>
            value.kind === 'image'
              ? { data: new Uint8Array([1, 2, 3]), mime: 'image/png', width: 1024, height: 1024 }
              : { data: new Uint8Array([1, 2, 3]), mime, duration: 5 },
          ),
        },
      }
    }
  })
  it('数量和纯音频策略在读文件前拒绝，非法 kind 不能穿过原型链', async () => {
    const ctx = context()
    await expect(
      videoReferences(
        Array.from({ length: 4 }, (_, i) => ref('video', `v${i}`)),
        ctx,
        limits,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      videoReferences([ref('audio')], ctx, { ...limits, allowAudioOnly: false }),
    ).rejects.toThrow('搭配图片或视频')
    await expect(
      videoReferences([{ assetId: 'bad', kind: '__proto__' } as unknown as AssetRef], ctx, limits),
    ).rejects.toThrow('不支持这种')
    expect(ctx.files.read).not.toHaveBeenCalled()
  })
  it.each([undefined, NaN, Infinity, 0])('拒绝无效时长 %s', async (duration) => {
    await expect(videoReferences([ref('audio')], context({ duration }), limits)).rejects.toThrow(
      '缺少可读取的有效时长',
    )
  })
  it('拒绝短于下限与长于上限的单段时长', async () => {
    await expect(
      videoReferences([ref('audio')], context({ duration: 1.9 }), limits),
    ).rejects.toThrow('要求至少 2 秒')
    await expect(
      videoReferences([ref('audio')], context({ duration: 15.1 }), limits),
    ).rejects.toThrow('超过')
  })
  it('每类累计时长单独限制，不能将多段各自合法但总计超限的素材提交', async () => {
    await expect(
      videoReferences([ref('video', 'v1'), ref('video', 'v2')], context({ duration: 8 }), limits),
    ).rejects.toThrow('参考视频总时长')
    await expect(
      videoReferences([ref('audio', 'a1'), ref('audio', 'a2')], context({ duration: 8 }), limits),
    ).rejects.toThrow('参考音频总时长')
  })
  it.each([{ width: NaN }, { width: undefined }, { height: Infinity }, { width: 1024.5 }])(
    '拒绝读不出的尺寸 %j',
    async (size) => {
      await expect(videoReferences([ref('image')], context(size), limits)).rejects.toThrow(
        '缺少可读取的尺寸信息',
      )
    },
  )
  it.each([{ width: 255 }, { width: 5761 }])('拒绝超出宽高范围的尺寸 %j', async (size) => {
    await expect(videoReferences([ref('image')], context(size), limits)).rejects.toThrow('像素')
  })
  it('拒绝宽高比超出范围的尺寸', async () => {
    await expect(
      videoReferences([ref('image')], context({ width: 256, height: 1024 }), limits),
    ).rejects.toThrow('宽高比')
  })
  it('平台 MIME 和尺寸上限独立；Ark 本地视频不编码成未支持的 data URI', async () => {
    await expect(
      videoReferences([ref('image')], context({ mime: 'image/bmp', width: 6000, height: 3000 }), {
        ...limits,
        platform: 'ark',
      }),
    ).resolves.toHaveLength(1)
    await expect(
      videoReferences([ref('image')], context({ mime: 'image/bmp' }), limits),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      videoReferences([ref('image')], context({ width: 256 }), { ...limits, platform: 'ark' }),
    ).rejects.toThrow('300')
    const ctx = context()
    await expect(
      videoReferences([ref('video')], ctx, { ...limits, platform: 'ark' }),
    ).rejects.toThrow('视频参考存储')
    expect(ctx.files.read).not.toHaveBeenCalled()
  })
  it('空文件、错误 MIME 和编码后超限的文件均阻断', async () => {
    await expect(
      videoReferences([ref('audio')], context({ data: new Uint8Array() }), limits),
    ).rejects.toThrow('不能是空文件')
    await expect(
      videoReferences([ref('video')], context({ mime: 'video/webm' }), limits),
    ).rejects.toThrow('不在允许范围')
    await expect(
      videoReferences([ref('video')], context({ data: new Uint8Array(48 * 1024 * 1024) }), limits),
    ).rejects.toThrow('编码后超过请求上限')
  })
})

it('Ark 视频采用独立的 200MB、24fps、像素面积与 MOV PCM 规则', async () => {
  const uploadVideo = vi.fn(async () => 'https://bucket.tos-cn-beijing.volces.com/video')
  const rules = { ...limits, platform: 'ark' as const, uploadVideo }
  const ctx = context({
    videoCodec: 'h264',
    frameRate: 24,
    audioCodecs: [],
    data: new Uint8Array(64 * 1024 * 1024),
  })
  const content = await videoReferences([ref('video')], ctx, rules)
  expect(content[0]).toMatchObject({ video_url: { url: expect.stringMatching(/^https:/) } })
  expect(uploadVideo).toHaveBeenCalledOnce()
  uploadVideo.mockClear()
  for (const over of [
    { width: 300, height: 300 },
    { frameRate: 23.976 },
    { videoCodec: 'vp9' },
    { duration: 16 },
    { audioCodecs: ['opus'] },
  ]) {
    await expect(
      videoReferences(
        [ref('video')],
        context({ videoCodec: 'h264', frameRate: 24, audioCodecs: [], ...over }),
        rules,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  }
  expect(uploadVideo).not.toHaveBeenCalled()
  await expect(
    videoReferences(
      [ref('video')],
      context({
        mime: 'video/quicktime',
        videoCodec: 'hevc',
        frameRate: 60,
        audioCodecs: ['pcm_s16le'],
      }),
      rules,
    ),
  ).resolves.toHaveLength(1)
})

describe('按模型声明检查参考素材', () => {
  const requirements: MediaRequirements = {
    video: {
      mime: ['video/mp4'],
      maxMB: 20,
      minDuration: 4,
      maxDuration: 10,
      totalDurationMax: 12,
      minFrameRate: 24,
      maxFrameRate: 60,
    },
  }
  const title = '示例视频模型'

  it('帧率、时长与总时长不符时按模型声明给出中文说明', async () => {
    await expect(
      videoReferences(
        [ref('video')],
        context({ videoCodec: 'h264', frameRate: 20, audioCodecs: [], duration: 5 }),
        { ...limits, requirements, title },
      ),
    ).rejects.toThrow(`参考视频帧率 20 fps，${title} 要求 24–60 fps`)

    await expect(
      videoReferences(
        [ref('video')],
        context({ videoCodec: 'h264', frameRate: 24, audioCodecs: [], duration: 2 }),
        { ...limits, requirements, title },
      ),
    ).rejects.toThrow(`只有 2 秒，${title} 要求至少 4 秒`)

    await expect(
      videoReferences(
        [ref('video', 'v1'), ref('video', 'v2')],
        context({ videoCodec: 'h264', frameRate: 24, audioCodecs: [], duration: 7 }),
        { ...limits, requirements, title },
      ),
    ).rejects.toThrow(`参考视频总时长 14 秒，超过 ${title} 的 12 秒上限`)
  })

  it('满足声明时放行', async () => {
    await expect(
      videoReferences(
        [ref('video')],
        context({ videoCodec: 'h264', frameRate: 30, audioCodecs: [], duration: 5 }),
        { ...limits, requirements, title },
      ),
    ).resolves.toHaveLength(1)
  })

  it('按任务模式追加的要求同样生效', async () => {
    const withTask: MediaRequirements = {
      ...requirements,
      videoTasks: { edit: { minDuration: 8 } },
    }
    await expect(
      videoReferences(
        [ref('video')],
        context({ videoCodec: 'h264', frameRate: 30, audioCodecs: [], duration: 5 }),
        { ...limits, requirements: withTask, title, videoTask: 'edit' },
      ),
    ).rejects.toThrow(`只有 5 秒，${title} 要求至少 8 秒`)
  })
})

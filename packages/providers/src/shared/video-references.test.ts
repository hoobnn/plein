import type { AssetRef } from '@plein/plugin-sdk'
import { describe, expect, it, vi } from 'vite-plus/test'
import { videoReferences } from './video-references'

// https://platform.minimax.io/docs/api-reference/video-generation-v2-create
// https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
const ref = (kind: AssetRef['kind'], assetId: string = kind): AssetRef => ({ kind, assetId })
const limits = { image: 9, video: 3, audio: 3, duration: 15, allowAudioOnly: true } as const
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
  it.each([undefined, NaN, Infinity, 0, 1.9, 15.1])('拒绝无效时长 %s', async (duration) => {
    await expect(videoReferences([ref('audio')], context({ duration }), limits)).rejects.toThrow(
      '可读取的时长',
    )
  })
  it('每类累计时长单独限制，不能将多段各自合法但总计超限的素材提交', async () => {
    await expect(
      videoReferences([ref('video', 'v1'), ref('video', 'v2')], context({ duration: 8 }), limits),
    ).rejects.toThrow('视频总时长')
    await expect(
      videoReferences([ref('audio', 'a1'), ref('audio', 'a2')], context({ duration: 8 }), limits),
    ).rejects.toThrow('音频总时长')
  })
  it.each([
    { width: NaN },
    { width: undefined },
    { height: Infinity },
    { width: 255 },
    { width: 1024.5 },
    { width: 5761 },
    { width: 256, height: 1024 },
  ])('拒绝无效尺寸 %j', async (size) => {
    await expect(videoReferences([ref('image')], context(size), limits)).rejects.toThrow(
      '可读取的尺寸',
    )
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
    ).rejects.toThrow('300–6000')
    const ctx = context()
    await expect(
      videoReferences([ref('video')], ctx, { ...limits, platform: 'ark' }),
    ).rejects.toThrow('上传至平台素材库')
    expect(ctx.files.read).not.toHaveBeenCalled()
  })
  it('空文件、错误 MIME 和编码后超限的文件均阻断', async () => {
    await expect(
      videoReferences([ref('audio')], context({ data: new Uint8Array() }), limits),
    ).rejects.toThrow('格式或大小')
    await expect(
      videoReferences([ref('video')], context({ mime: 'video/webm' }), limits),
    ).rejects.toThrow('格式或大小')
    await expect(
      videoReferences([ref('video')], context({ data: new Uint8Array(48 * 1024 * 1024) }), limits),
    ).rejects.toThrow('编码后超过请求上限')
  })
})

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

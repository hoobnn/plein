import { describe, expect, it } from 'vite-plus/test'
import { bailianProvider } from './index'

describe('百炼目录', () => {
  const ids = bailianProvider.models.map((model) => model.id)

  it('不含 plein 宿主跑不通的模型', () => {
    for (const id of ['qwen3-asr-flash', 'wan2.2-s2v', 'happyhorse-1.0-video-edit']) {
      expect(ids).not.toContain(id)
    }
    expect(
      ids.filter((id) => id.startsWith('cosyvoice-') || /^qwen-audio-.*-tts-/.test(id)),
    ).toEqual([])
  })

  it('保留可用的对话、图片、视频与语音模型', () => {
    expect(ids).toEqual(
      expect.arrayContaining(['qwen3-tts-flash', 'qwen-image-3.0-pro', 'wanx2.1-imageedit']),
    )
  })
})

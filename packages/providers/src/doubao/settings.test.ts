import { describe, expect, it } from 'vite-plus/test'
import { arkPlanProvider } from '../ark'
import { doubaoProvider } from './index'

const titles = (settings: { shape: Record<string, { meta(): { title?: string } | undefined }> }) =>
  Object.fromEntries(
    Object.entries(settings.shape).map(([key, field]) => [key, field.meta()?.title]),
  )

describe('豆包语音设置表单', () => {
  it('只有音色、格式、采样率，标题沿用原表单，不暴露 speed', () => {
    expect(titles(doubaoProvider.settings as never)).toEqual({
      voice: '默认音色 ID',
      format: '音频格式',
      sampleRate: '采样率',
    })
  })

  it('方舟套餐的语音设置同样不带 speed', () => {
    const shape = (arkPlanProvider.settings as unknown as { shape: Record<string, unknown> }).shape
    expect(Object.keys(shape)).toEqual(expect.arrayContaining(['voice', 'format', 'sampleRate']))
    expect(shape).not.toHaveProperty('speed')
  })
})

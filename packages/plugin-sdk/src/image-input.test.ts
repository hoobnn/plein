import { describe, expect, it } from 'vite-plus/test'
import { imageModelProblem } from './image-input'
import type { ModelInfo } from './provider'

const model: ModelInfo = {
  id: 'wan-image',
  title: '万相图片',
  capabilities: ['image.generate'],
  limits: {
    resolutions: ['1K', '2K', '4K'],
    image: {
      resolutionsByAspectRatio: { '21:9': ['2K', '4K'] },
      referenceResolutions: ['1K', '2K'],
      sequential: { option: 'enable_sequential', maxCount: 12, resolutions: ['1K', '2K'] },
      size: {
        minPixels: 512 ** 2,
        maxPixels: 2048 ** 2,
        minRatio: 1 / 8,
        maxRatio: 8,
        tiers: ['1K', '2K', '4K'],
      },
    },
  },
}

describe('图片模型组合预检', () => {
  it('不支持的分辨率只给一个统一说法，并列出了可选值', () => {
    expect(imageModelProblem(model, { resolution: '8K' }, 0)).toBe(
      '万相图片 不支持分辨率 8K；请选择 1K、2K、4K，或使用默认分辨率',
    )
  })

  it.each([
    [{ resolution: '1K', aspectRatio: '21:9' }, 0, '（当前画幅为 21:9）', '2K、4K'],
    [{ resolution: '4K' }, 1, '（当前使用参考图）', '1K、2K'],
    [
      { resolution: '4K', options: { enable_sequential: true } },
      0,
      '（当前开启组图模式）',
      '1K、2K',
    ],
    [{ options: { size: '4K', enable_sequential: true } }, 0, '（当前开启组图模式）', '1K、2K'],
  ] as const)('组合限制说明具体条件：%j', (params, references, condition, choices) => {
    const problem = imageModelProblem(model, params, references)
    expect(problem).toContain(condition)
    expect(problem).toContain(`请选择 ${choices}，或使用默认分辨率`)
    expect(problem).not.toContain('当前模式不支持尺寸')
  })

  it('自定义尺寸超限写出实际总像素范围、宽高比和当前值', () => {
    expect(imageModelProblem(model, { options: { size: '4096*4096' } }, 0)).toBe(
      '万相图片 自定义尺寸须在 262144–4194304 像素（宽×高）之间、宽高比 1:8–8:1，现在是 4096*4096',
    )
  })
})

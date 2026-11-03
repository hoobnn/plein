import { describe, expect, it } from 'vite-plus/test'
import {
  videoModelProblem,
  videoReferenceProblem,
  videoReferencePrompt,
  videoReferenceTokens,
  videoTaskOverrides,
} from './video-input'
import type { ModelInfo } from './provider'

const counts = { image: 2, video: 1, audio: 1 }
const model: ModelInfo = {
  id: 'seedance',
  title: 'Seedance',
  capabilities: ['video.generate'],
  limits: { optionalVideoPrompt: true, referenceMedia: { video: 3, audio: 3, audioOnly: false } },
}
describe('视频参考编号和预检', () => {
  it('平台转换保持种类和编号，保留邮件、转义、普通元素引用', () => {
    const text = '@图片2 跟随 @video1，使用 @音频1；@林夏 a@image1.com \\@image1 @@video1'
    expect(videoReferenceTokens(text).map((t) => [t.kind, t.index])).toEqual([
      ['image', 2],
      ['video', 1],
      ['audio', 1],
    ])
    expect(videoReferencePrompt(text, 'ark')).toBe(
      '@image2 跟随 @video1，使用 @audio1；@林夏 a@image1.com \\@image1 @@video1',
    )
    expect(videoReferencePrompt(text, 'minimax')).toBe(
      '图片2 跟随 视频1，使用 音频1；@林夏 a@image1.com \\@image1 @@video1',
    )
    expect(videoReferenceProblem('@image2 @video1 @audio1', counts)).toBeNull()
    expect(videoReferenceProblem('@video3', { ...counts, video: 2 }, 'minimax-video')).toBe(
      '引用 视频3 超出当前视频数量（2 段）',
    )
    expect(videoReferenceProblem('@image3', counts)).toBe('引用 @image3 超出当前图片数量（2 张）')
  })
  it('音频单独参考、编辑模式、空提示词与具体画幅按模型前置校验', () => {
    const params = { mode: 'reference', model: 'p:m' }
    expect(videoModelProblem(model, params, { image: 0, video: 0, audio: 1 }, '节拍')).toContain(
      '搭配',
    )
    expect(videoModelProblem(model, params, counts, '')).toBeNull()
    expect(videoModelProblem(model, { mode: 'text' }, counts, '')).toContain('提示词为空')
    const promptRequired = { ...model, limits: { referenceMedia: model.limits!.referenceMedia! } }
    expect(videoModelProblem(promptRequired, params, counts, '')).toContain('提示词为空')
    expect(
      videoModelProblem(promptRequired, { mode: 'text' }, { image: 0, video: 0, audio: 0 }, ''),
    ).toContain('提示词为空')
    expect(
      videoModelProblem(
        model,
        { ...params, options: { 'p:m': { omni_reference_task_type: 'edit' } } },
        { image: 1, video: 0, audio: 0 },
        '编辑',
      ),
    ).toContain('需要参考视频')
    expect(
      videoModelProblem(
        { ...model, id: 'MiniMax-H3-Lite' },
        { ...params, aspectRatio: 'auto' },
        counts,
        'p',
      ),
    ).toContain('具体画幅')
    expect(
      videoModelProblem(
        { ...model, id: 'MiniMax-H3' },
        { ...params, aspectRatio: 'auto' },
        counts,
        'p',
      ),
    ).toBeNull()
    expect(videoModelProblem(model, { mode: 'image' }, counts, '@image1')).toContain('超出')
  })
})

it('模型声明的输入模式在运行前阻断；服务端仍校验最终编号', () => {
  const limits = { ...model.limits, videoModes: ['text', 'image', 'frames', 'reference'] as const }
  expect(videoModelProblem({ ...model, limits }, { mode: 'lastFrame' }, counts, '结束')).toBe(
    'Seedance 不支持「仅尾帧」模式，请更换模式或模型',
  )
  expect(
    videoModelProblem(model, { mode: 'reference' }, { image: 0, video: 1, audio: 0 }, '@image1'),
  ).toContain('超出')
  expect(
    videoModelProblem(
      { ...model, id: 'MiniMax-H3' },
      { mode: 'reference' },
      { image: 0, video: 2, audio: 0 },
      '@video3',
    ),
  ).toBe('引用 视频3 超出当前视频数量（2 段）')
  expect(
    videoModelProblem(model, { mode: 'reference' }, { image: 0, video: 1, audio: 0 }, '@image1', {
      deferReferenceCounts: true,
    }),
  ).toBeNull()
})

it.each(['volc/ark', 'volc/ark-plan'])('%s 的 Seedance 2.5 草稿模式只允许 480p', (provider) => {
  const seedance: ModelInfo = {
    ...model,
    id: 'doubao-seedance-2-5-260628',
  }
  const params = (resolution: unknown, draft = true) => ({
    mode: 'text',
    model: `${provider}:doubao-seedance-2-5-260628`,
    resolution,
    options: { [`${provider}:doubao-seedance-2-5-260628`]: { draft } },
  })
  expect(videoModelProblem(seedance, params('720p'), counts, '预览')).toBe(
    '草稿模式只支持 480p，当前是 720p',
  )
  // 留空表示跟平台默认，也不是 480p
  expect(videoModelProblem(seedance, params(''), counts, '预览')).toBe(
    '草稿模式只支持 480p，当前是 默认分辨率',
  )
  expect(videoModelProblem(seedance, params('480p'), counts, '预览')).toBeNull()
  // 未勾草稿时不拦；非 Seedance 2.5 模型不做这项预检（运行时由平台原始报错说明）
  expect(videoModelProblem(seedance, params('720p', false), counts, '预览')).toBeNull()
  expect(videoModelProblem(model, params('720p'), counts, '预览')).toBeNull()
})

it.each(['volc/ark', 'volc/ark-plan'])(
  '%s 的 Seedance 2.5 首帧跟随画幅、自动时长取 -1',
  (provider) => {
    const model = `${provider}:doubao-seedance-2-5-260628`
    expect(
      videoTaskOverrides({
        model,
        mode: 'image',
        options: { [model]: { adaptive_duration: true } },
      }),
    ).toEqual({ duration: -1, aspectRatio: 'auto' })
  },
)

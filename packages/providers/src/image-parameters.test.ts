import { describe, expect, it } from 'vite-plus/test'
import type { CapabilityInput } from '@plein/plugin-sdk'
import { minimaxProvider } from './minimax'
import { bailianProvider } from './bailian'
import { fakeContext } from './testing'

const imageResult = {
  output: {
    choices: [
      {
        message: {
          content: [{ image: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.png' }],
        },
      },
    ],
  },
}
const reference = { assetId: 'ref', kind: 'image' as const }

describe('图片参数官方组合边界', () => {
  it('image-01 的 1K + 21:9 在联网前拒绝，默认比例和 2K 保持超宽画幅', async () => {
    const { ctx, fetch, body } = fakeContext(minimaxProvider, [
      { data: { image_urls: ['https://cdn.hailuoai.com/a.png'] } },
      { data: { image_urls: ['https://cdn.hailuoai.com/a.png'] } },
    ])
    await expect(
      minimaxProvider.submit(
        {
          capability: 'image.generate',
          model: 'image-01',
          input: { prompt: '超宽风景', resolution: '1K', extra: { aspectRatio: '21:9' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
    await minimaxProvider.submit(
      {
        capability: 'image.generate',
        model: 'image-01',
        input: { prompt: '超宽风景', extra: { aspectRatio: '21:9' } },
      },
      ctx,
    )
    expect(body()).toMatchObject({ aspect_ratio: '21:9' })
    await minimaxProvider.submit(
      {
        capability: 'image.generate',
        model: 'image-01',
        input: { prompt: '超宽风景', resolution: '2K', extra: { aspectRatio: '21:9' } },
      },
      ctx,
    )
    const sent = body(1)
    expect(sent.width / sent.height).toBeCloseTo(21 / 9, 1)
    expect(sent.height).toBeGreaterThanOrEqual(512)
    expect(sent.aspect_ratio).toBeUndefined()
  })

  it('live 使用官方 style 对象，支持人物参考和九张输出', async () => {
    const { ctx, body } = fakeContext(minimaxProvider, [
      { data: { image_urls: Array.from({ length: 9 }, () => 'https://cdn.hailuoai.com/a.png') } },
    ])
    await minimaxProvider.submit(
      {
        capability: 'image.generate',
        model: 'image-01-live',
        input: {
          prompt: '水彩人像',
          count: 9,
          references: [reference],
          extra: {
            aspectRatio: '3:4',
            style_type: '水彩',
            style_weight: 0.6,
            prompt_optimizer: true,
            aigc_watermark: false,
          },
        },
      },
      ctx,
    )
    expect(body()).toMatchObject({
      model: 'image-01-live',
      n: 9,
      aspect_ratio: '3:4',
      style: { style_type: '水彩', style_weight: 0.6 },
      prompt_optimizer: true,
      aigc_watermark: false,
      subject_reference: [{ type: 'character' }],
    })
    expect(body()).not.toHaveProperty('style_type')
  })

  it.each<Partial<CapabilityInput<'image.generate'>>>([
    { extra: { aspectRatio: '21:9' } },
    { resolution: '1K' },
    { width: 1024, height: 1024 },
    { extra: { style_type: 'unknown' } },
    { extra: { style_type: '水彩', style_weight: 0 } },
    { extra: { style_weight: 0.5 } },
  ])('live 不支持的参数在联网前拒绝：%j', async (input) => {
    const { ctx, fetch } = fakeContext(minimaxProvider)
    await expect(
      minimaxProvider.submit(
        { capability: 'image.generate', model: 'image-01-live', input: { prompt: 'p', ...input } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('Qwen 的 2K 档位转为 DashScope 像素尺寸，智能比例默认不传 size', async () => {
    const { ctx, body } = fakeContext(bailianProvider, [imageResult, imageResult])
    await bailianProvider.submit(
      {
        capability: 'image.generate',
        model: 'qwen-image-3.0-pro',
        input: { prompt: 'p', count: 6, resolution: '2K', extra: { aspectRatio: '16:9' } },
      },
      ctx,
    )
    expect(body().parameters).toMatchObject({ size: '2720*1536', n: 6 })
    await bailianProvider.submit(
      {
        capability: 'image.generate',
        model: 'qwen-image-3.0-pro',
        input: {
          prompt: 'p',
          extra: {
            aspectRatio: 'auto',
            prompt_extend: true,
            prompt_extend_mode: 'direct',
            enable_thinking: true,
          },
        },
      },
      ctx,
    )
    expect(body(1).parameters).not.toHaveProperty('size')
    expect(body(1).parameters).toMatchObject({ prompt_extend: true, enable_thinking: true })
  })

  it('Wan 文生图发送 4K 像素尺寸，智能画幅发送原生档位；组图可发送十二张', async () => {
    const { ctx, body } = fakeContext(bailianProvider, [imageResult, imageResult, imageResult])
    await bailianProvider.submit(
      {
        capability: 'image.generate',
        model: 'wan2.7-image-pro',
        input: { prompt: 'p', resolution: '4K', extra: { aspectRatio: '16:9' } },
      },
      ctx,
    )
    const [width, height] = body().parameters.size.split('*').map(Number)
    expect(width * height).toBeGreaterThan(2048 ** 2)
    expect(width * height).toBeLessThanOrEqual(4096 ** 2)
    await bailianProvider.submit(
      {
        capability: 'image.generate',
        model: 'wan2.7-image-pro',
        input: { prompt: 'p', resolution: '4K', extra: { aspectRatio: 'auto' } },
      },
      ctx,
    )
    expect(body(1).parameters.size).toBe('4K')
    await bailianProvider.submit(
      {
        capability: 'image.generate',
        model: 'wan2.7-image-pro',
        input: {
          prompt: '组图',
          count: 12,
          resolution: '2K',
          references: [reference],
          extra: { enable_sequential: true, aspectRatio: '9:16' },
        },
      },
      ctx,
    )
    expect(body(2).parameters).toMatchObject({ n: 12, enable_sequential: true, size: '1536*2720' })
  })

  it.each([
    ['wan2.7-image-pro', { resolution: '4K', references: [reference] }],
    ['wan2.7-image-pro', { resolution: '4K', extra: { enable_sequential: true } }],
    ['wan2.7-image-pro', { count: 5 }],
    ['wan2.7-image-pro', { count: 13, extra: { enable_sequential: true } }],
    ['wan2.7-image-pro', { extra: { size: '4096*4096' }, references: [reference] }],
    ['wan2.7-image-pro', { extra: { size: '4K', enable_sequential: true } }],
    ['qwen-image-3.0-pro', { resolution: '4K' }],
    ['qwen-image-3.0-pro', { resolution: '2K', extra: { aspectRatio: 'auto' } }],
    ['qwen-image-3.0-pro', { count: 7 }],
    ['qwen-image-3.0-pro', { extra: { size: '4096*4096' } }],
    ['qwen-image-3.0-pro', { extra: { size: '100*100' } }],
    ['qwen-image-3.0-pro', { extra: { size: '1024*1' } }],
    ['qwen-image-3.0-pro', { extra: { size: 'bad' } }],
    ['qwen-image-3.0-pro', { extra: { prompt_extend_mode: 'agent' }, references: [reference] }],
  ] as const)('%s 无效组合不读取素材、不联网：%j', async (model, input) => {
    const { ctx, fetch } = fakeContext(bailianProvider)
    await expect(
      bailianProvider.submit(
        {
          capability: 'image.generate',
          model,
          input: { prompt: 'p', ...input } as CapabilityInput<'image.generate'>,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
    expect(ctx.files.read).not.toHaveBeenCalled()
  })

  it('显式自定义尺寸优先于画幅和档位，兼容 x 与 *', async () => {
    const { ctx, body } = fakeContext(bailianProvider, [imageResult])
    await bailianProvider.submit(
      {
        capability: 'image.generate',
        model: 'qwen-image-3.0',
        input: { prompt: 'p', resolution: '2K', extra: { aspectRatio: 'auto', size: '1536x1024' } },
      },
      ctx,
    )
    expect(body().parameters.size).toBe('1536*1024')
  })

  it('Wan 自动时长只发送 duration=-1，不泄露界面参数名', async () => {
    const { ctx, body } = fakeContext(bailianProvider, [{ output: { task_id: 't' } }])
    await bailianProvider.submit(
      {
        capability: 'video.generate',
        model: 'wan3.0-video',
        input: { prompt: 'p', duration: 5, extra: { adaptive_duration: true } },
      },
      ctx,
    )
    expect(body().parameters.duration).toBe(-1)
    expect(body().parameters).not.toHaveProperty('adaptive_duration')
  })
})

it.each([
  { duration: 21, references: [{ assetId: 'v', kind: 'video' as const }] },
  {
    duration: 5,
    references: [
      { assetId: 'v1', kind: 'video' as const },
      { assetId: 'v2', kind: 'video' as const },
    ],
  },
])('Wan 在上传之前拒绝超出时长预算的参考任务：%j', async (input) => {
  const { ctx, fetch } = fakeContext(bailianProvider, [], { mime: 'video/mp4', duration: 10 })
  await expect(
    bailianProvider.submit(
      { capability: 'video.generate', model: 'wan3.0-video', input: { prompt: 'p', ...input } },
      ctx,
    ),
  ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('时长') })
  expect(fetch).not.toHaveBeenCalled()
})

it.each([{ resolution: '4K' }, { aspectRatio: '3:2' }, { extra: { adaptive_duration: 'yes' } }])(
  'Wan 视频参数不合法时不发起请求：%j',
  async (input) => {
    const { ctx, fetch } = fakeContext(bailianProvider)
    await expect(
      bailianProvider.submit(
        { capability: 'video.generate', model: 'wan3.0-video', input: { prompt: 'p', ...input } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
  },
)

it('Wan 恰好三十秒的输入加输出可提交，素材只读一次，extra 不能覆盖通用参数', async () => {
  const policy = {
    upload_host: 'https://dashscope.oss-cn-beijing.aliyuncs.com',
    upload_dir: 'tmp',
    oss_access_key_id: 'id',
    signature: 'sig',
    policy: 'policy',
    x_oss_object_acl: 'private',
    x_oss_forbid_overwrite: 'true',
  }
  const { ctx, body } = fakeContext(
    bailianProvider,
    [{ data: policy }, {}, { output: { task_id: 't' } }],
    { mime: 'video/mp4', duration: 10 },
  )
  await bailianProvider.submit(
    {
      capability: 'video.generate',
      model: 'wan3.0-video',
      input: {
        prompt: 'p',
        duration: 20,
        resolution: '720P',
        references: [{ assetId: 'v', kind: 'video' }],
        extra: { resolution: '4K', ratio: 'bad', duration: 100 },
      },
    },
    ctx,
  )
  expect(ctx.files.read).toHaveBeenCalledTimes(1)
  expect(body(2).parameters).toMatchObject({ resolution: '720P', ratio: '16:9', duration: 20 })
})

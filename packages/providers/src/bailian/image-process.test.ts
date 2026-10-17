import { describe, expect, it } from 'vite-plus/test'
import { fakeContext } from '../testing'
import { bailianProvider } from './index'

// https://help.aliyun.com/zh/model-studio/wanx-image-edit-api-reference
const model = 'wanx2.1-imageedit'
const image = { assetId: 'source', kind: 'image' as const }
const policy = {
  data: {
    upload_host: 'https://dashscope.oss-cn-beijing.aliyuncs.com',
    upload_dir: 'tmp',
    oss_access_key_id: 'id',
    signature: 'sig',
    policy: 'p',
    x_oss_object_acl: 'private',
    x_oss_forbid_overwrite: 'true',
  },
}
const setup = (reply: unknown = { output: { task_id: 'task1' } }) =>
  fakeContext(bailianProvider, [policy, new Response(null, { status: 200 }), reply])

describe('万相精修 HTTP 合同', () => {
  it.each([
    {
      operation: 'upscale' as const,
      scale: 3,
      functionName: 'super_resolution',
      params: { n: 1, upscale_factor: 3 },
    },
    {
      operation: 'outpaint' as const,
      expansion: { top: 1, bottom: 2, left: 1.5, right: 1.25 },
      functionName: 'expand',
      params: { n: 1, top_scale: 1, bottom_scale: 2, left_scale: 1.5, right_scale: 1.25 },
    },
  ])('$operation 走图像编辑异步接口并保留任务 ID', async (input) => {
    const f = setup()
    const result = await bailianProvider.submit(
      {
        capability: 'image.process',
        model,
        input: {
          image,
          operation: input.operation,
          scale: input.scale,
          expansion: input.expansion,
        },
      },
      f.ctx,
    )
    expect(result).toMatchObject({ state: 'pending', remoteId: 'task1' })
    expect(f.fetch.mock.calls[2]?.[0]).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis',
    )
    const headers = new Headers(f.fetch.mock.calls[2]?.[1]?.headers)
    expect(headers.get('X-DashScope-Async')).toBe('enable')
    expect(headers.get('X-DashScope-OssResourceResolve')).toBe('enable')
    expect(f.body(2)).toMatchObject({
      model,
      input: {
        function: input.functionName,
        base_image_url: expect.stringMatching(/^oss:\/\/tmp\//),
      },
      parameters: input.params,
    })
  })
  it.each([
    { operation: 'upscale' as const, scale: NaN },
    { operation: 'upscale' as const, scale: 5 },
    { operation: 'outpaint' as const, expansion: { top: Infinity, bottom: 1, left: 1, right: 1 } },
    { operation: 'cutout' as const },
    { operation: 'upscale' as const, image: { assetId: 'audio', kind: 'audio' as const } },
  ])('参数无效时不上传也不提交 %j', async (input) => {
    const f = setup()
    await expect(
      bailianProvider.submit(
        { capability: 'image.process', model, input: { image, ...input } },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it.each([
    { mime: 'video/mp4' },
    { mime: 'image/gif' },
    { width: 511 },
    { height: 4097 },
    { width: NaN },
  ])('图片格式和尺寸在上传前校验 %j', async (opts) => {
    const f = fakeContext(bailianProvider, [], opts)
    await expect(
      bailianProvider.submit(
        { capability: 'image.process', model, input: { image, operation: 'upscale' } },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('提交成功但 task_id 缺失时保持 unknown，已有上传不造成重新生成', async () => {
    const f = setup({ output: {} })
    await expect(
      bailianProvider.submit(
        { capability: 'image.process', model, input: { image, operation: 'upscale' } },
        f.ctx,
      ),
    ).rejects.toMatchObject({ code: 'unknown' })
    expect(f.fetch).toHaveBeenCalledTimes(3)
  })
})

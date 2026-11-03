import { connect, createElement, setParams } from '@plein/doc'
import type { PreparedInput } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, request } from '../testing'

afterEach(() => vi.restoreAllMocks())

it('图片参数在服务端预览和直接执行中使用同一组合限制，修正后可恢复', async () => {
  const { server } = await bootServer()
  for (const [provider, secret] of [
    ['minimax/api', 'MINIMAX_API_KEY'],
    ['aliyun/bailian', 'DASHSCOPE_API_KEY'],
  ])
    server.plugins.configs.update(provider!, {
      enabled: true,
      secrets: { [secret!]: 'local-only' },
    })
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('本地测试不得联网'))
  const { id, doc } = await createCanvas(server)
  for (const [model, extra, invalid, valid] of [
    [
      'minimax/api:image-01',
      {},
      { resolution: '1K', aspectRatio: '21:9' },
      { resolution: '2K', aspectRatio: '21:9' },
    ],
    ['minimax/api:image-01-live', {}, { resolution: '2K' }, { resolution: '' }],
    [
      'aliyun/bailian:wan2.7-image-pro',
      { enable_sequential: true },
      { resolution: '4K', count: 12 },
      { resolution: '2K', count: 12 },
    ],
    ['aliyun/bailian:qwen-image-3.0-pro', {}, { count: 7 }, { count: 6 }],
    ['aliyun/bailian:qwen-image-3.0-pro', { size: '4096*4096' }, {}, { options: {} }],
    [
      'aliyun/bailian:qwen-image-3.0-pro',
      {},
      { resolution: '4K' },
      { options: { 'aliyun/bailian:qwen-image-3.0-pro': { size: '1536*1024' } } },
    ],
  ] as const) {
    const params = { model, prompt: '仅本地检查', options: { [model]: extra }, ...invalid }
    const node = addNode(doc, 'plein/image', { params })
    const preview = async () => {
      const response = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
      expect(response.status).toBe(200)
      return (await response.json()) as PreparedInput
    }
    const blocked = await preview()
    expect(blocked.status, model).toBe('blocked')
    expect(blocked.blocked.length).toBeGreaterThan(0)
    if ('resolution' in invalid)
      expect(
        blocked.blocked.filter((issue) => issue.message.includes('不支持分辨率')),
      ).toHaveLength(1)
    await expect(
      server.plugins.runNode({ type: 'plein/image', version: 1, ownerId: 'local', params }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).not.toHaveBeenCalled()
    setParams(doc, node, valid)
    expect((await preview()).status, model).toBe('ready')
  }
  const reference = createElement(doc, {
    kind: 'image',
    assetId: 'a'.repeat(64),
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const withReference = addNode(doc, 'plein/image', {
    params: {
      model: 'aliyun/bailian:wan2.7-image-pro',
      prompt: '参考图与 4K 在预览时阻断',
      resolution: '4K',
    },
  })
  connect(doc, [reference, 'image'], [withReference, 'references'])
  const referenceResponse = await request(
    server,
    `/api/canvases/${id}/nodes/${withReference}/input`,
  )
  const referencePreview = (await referenceResponse.json()) as PreparedInput
  expect(
    referencePreview.blocked.filter((issue) => issue.message.includes('不支持分辨率')),
  ).toEqual([
    {
      code: 'prepare_failed',
      message:
        'wan2.7-image-pro 不支持分辨率 4K（当前使用参考图）；请选择 1K、2K，或使用默认分辨率',
    },
  ])
  const model = 'aliyun/bailian:wan3.0-video'
  const node = addNode(doc, 'plein/video', {
    params: { model, prompt: '本地预览', options: { [model]: { adaptive_duration: true } } },
  })
  const response = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
  const preview = (await response.json()) as PreparedInput
  expect(preview.status).toBe('ready')
  expect(preview.params.duration).toBe(-1)
  setParams(doc, node, { prompt: '' })
  const emptyResponse = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
  const emptyPreview = (await emptyResponse.json()) as PreparedInput
  expect(emptyPreview.blocked).toContainEqual({
    code: 'prepare_failed',
    message: '视频提示词为空',
  })
  expect(fetch).not.toHaveBeenCalled()
}, 30_000)

import { connect, createElement, setParams } from '@plein/doc'
import type { CapabilityInput, ProviderRequest } from '@plein/plugin-sdk'
import type { Catalog, PreparedInput } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'

const videoSpec = mockProvider.models.find((m) => m.id === 'video')!
const processSpec = mockProvider.models.find((m) => m.id === 'image-process')!
const videoLimits = videoSpec.limits
const processLimits = processSpec.limits
afterEach(() => {
  videoSpec.limits = videoLimits
  processSpec.limits = processLimits
  vi.restoreAllMocks()
})
const boot = async () => {
  const { server } = await bootServer()
  mockSettings(server, {})
  const { id, doc } = await createCanvas(server)
  const asset = (kind: 'image' | 'video' | 'audio', tag: string) =>
    createElement(doc, { kind, assetId: tag.repeat(64), x: 0, y: 0, w: 100, h: 100 })
  const preview = async (node: string) => {
    const response = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
    expect(response.status).toBe(200)
    return (await response.json()) as PreparedInput
  }
  const run = async (node: string, input: PreparedInput) => {
    const response = await request(server, `/api/canvases/${id}/nodes/${node}/run`, {
      method: 'POST',
      body: JSON.stringify({ expect: input.inputHash }),
    })
    expect(response.status).toBe(202)
    const { runId } = (await response.json()) as { runId: string }
    return { runId, status: await server.runs.wait(runId) }
  }
  return { server, id, doc, asset, preview, run }
}

describe('F6/F8 实际输入、阻断与有效参数合同', () => {
  it('真实 API 预览覆盖空参考、错误模式、模型媒体限额、图片超限，阻断时不调 Provider', async () => {
    const f = await boot()
    videoSpec.limits = {
      ...videoLimits,
      references: { max: 1 },
      referenceMedia: { video: 0, audio: 0 },
    }
    const submit = vi.spyOn(mockProvider, 'submit')
    const sources = {
      image: f.asset('image', 'a'),
      other: f.asset('image', 'b'),
      video: f.asset('video', 'c'),
      audio: f.asset('audio', 'd'),
    }
    const cases = [
      { mode: 'reference', refs: [], text: '至少 1 份' },
      { mode: 'text', refs: [['video', 'videos']], text: '需要选择多模态参考模式' },
      { mode: 'reference', refs: [['audio', 'audios']], text: '数量超过上限' },
      {
        mode: 'reference',
        refs: [
          ['image', 'images'],
          ['other', 'images'],
        ],
        text: '最多支持 1 张参考图',
      },
    ] as const
    for (const test of cases) {
      const target = addNode(f.doc, 'plein/video', { params: { mode: test.mode, prompt: '测试' } })
      for (const [kind, port] of test.refs)
        connect(f.doc, [sources[kind], kind === 'other' ? 'image' : kind], [target, port])
      const input = await f.preview(target)
      expect(input.status).toBe('blocked')
      expect(input.blocked.some((issue) => issue.message.includes(test.text))).toBe(true)
      expect((await f.run(target, input)).status).toBe('failed')
    }
    expect(submit).not.toHaveBeenCalled()
  })

  it('媒体按声明顺序预览并冻结，POST 与 inputHash 使用同一份素材', async () => {
    const f = await boot()
    const sources = [f.asset('image', 'a'), f.asset('video', 'b'), f.asset('audio', 'c')]
    const target = addNode(f.doc, 'plein/video', {
      params: { mode: 'reference', prompt: '跟着声音运动' },
    })
    connect(f.doc, [sources[2]!, 'audio'], [target, 'audios'])
    connect(f.doc, [sources[1]!, 'video'], [target, 'videos'])
    connect(f.doc, [sources[0]!, 'image'], [target, 'images'])
    const seen: ProviderRequest[] = []
    const original = mockProvider.submit
    vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
      seen.push(req)
      return original(req, ctx)
    })
    const input = await f.preview(target)
    expect(input.status).toBe('ready')
    expect(Object.keys(input.inputs)).toEqual(['images', 'videos', 'audios'])
    expect(seen).toEqual([])
    const result = await f.run(target, input)
    expect(result.status).toBe('succeeded')
    const posted = seen[0]?.input as CapabilityInput<'video.generate'>
    expect(posted.references?.map((r) => r.assetId)).toEqual(
      Object.values(input.inputs)
        .flat()
        .map((r) => r.assetId),
    )
    expect(f.server.runs.store.get(result.runId)?.cache_key).toBe(input.inputHash)
  })

  it('默认精修操作按模型能力选择；缺原图或不支持操作在 API 预览和运行都阻断', async () => {
    const f = await boot()
    processSpec.limits = { imageOperations: ['cutout'] }
    const catalog = (await (await request(f.server, '/api/catalog')).json()) as Catalog
    expect(
      catalog.nodes.find((node) => node.type === 'plein/image-process')?.defaults.operation,
    ).toBe('cutout')
    const submit = vi.spyOn(mockProvider, 'submit')
    const source = f.asset('image', 'a')
    const missing = addNode(f.doc, 'plein/image-process', { params: { operation: 'cutout' } })
    const unsupported = addNode(f.doc, 'plein/image-process', { params: { operation: 'outpaint' } })
    connect(f.doc, [source, 'image'], [unsupported, 'image'])
    for (const [target, reason] of [
      [missing, '一张原图'],
      [unsupported, '不支持这项精修操作'],
    ]) {
      const input = await f.preview(target!)
      expect(input.status).toBe('blocked')
      expect(input.blocked.some((issue) => issue.message.includes(reason!))).toBe(true)
      expect((await f.run(target!, input)).status).toBe('failed')
    }
    expect(submit).not.toHaveBeenCalled()
  })

  it('只显示并缓存当前精修操作真正使用的字段，调用 Provider 不夹带无效参数', async () => {
    const f = await boot()
    const source = f.asset('image', 'a')
    const target = addNode(f.doc, 'plein/image-process', {
      params: { operation: 'upscale', scale: 2 },
    })
    connect(f.doc, [source, 'image'], [target, 'image'])
    const seen: ProviderRequest[] = []
    const original = mockProvider.submit
    vi.spyOn(mockProvider, 'submit').mockImplementation(async (req, ctx) => {
      seen.push(req)
      return original(req, ctx)
    })
    const before = await f.preview(target)
    expect(before.params).toHaveProperty('scale', 2)
    expect(before.params).not.toHaveProperty('left')
    setParams(f.doc, target, { left: 1.9, top: 1.6 })
    expect((await f.preview(target)).inputHash).toBe(before.inputHash)
    expect((await f.run(target, before)).status).toBe('succeeded')
    const upscale = seen[0]?.input as CapabilityInput<'image.process'>
    expect(upscale).toMatchObject({ operation: 'upscale', scale: 2 })
    expect(upscale).not.toHaveProperty('expansion')
    setParams(f.doc, target, { operation: 'outpaint' })
    const outpaint = await f.preview(target)
    expect(outpaint.params).not.toHaveProperty('scale')
    expect(outpaint.params).toHaveProperty('left', 1.9)
    setParams(f.doc, target, { scale: 4 })
    expect((await f.preview(target)).inputHash).toBe(outpaint.inputHash)
    expect((await f.run(target, outpaint)).status).toBe('succeeded')
    expect(seen[1]?.input).toMatchObject({
      operation: 'outpaint',
      expansion: { top: 1.6, bottom: 1, left: 1.9, right: 1.5 },
    })
    expect(seen[1]?.input).not.toHaveProperty('scale')
    setParams(f.doc, target, { operation: 'cutout' })
    const cutout = await f.preview(target)
    expect(cutout.params).not.toHaveProperty('scale')
    expect(cutout.params).not.toHaveProperty('left')
    expect((await f.run(target, cutout)).status).toBe('succeeded')
    expect(seen[2]?.input).not.toHaveProperty('scale')
    expect(seen[2]?.input).not.toHaveProperty('expansion')
  })
})

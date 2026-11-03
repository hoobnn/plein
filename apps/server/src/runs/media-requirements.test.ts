import { Readable } from 'node:stream'
import { connect, createDoc, createElement } from '@plein/doc'
import type { AssetRef, ModelSpec, PortValue } from '@plein/plugin-sdk'
import type { Asset, PreparedInput } from '@plein/protocol'
import { mockProvider } from '@plein/providers'
import { solidPng } from '../../../../packages/providers/src/mock/media'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { PluginHost } from '../plugins/host'
import { addNode, bootServer, createCanvas, mockSettings, request } from '../testing'
import { clearMediaProbeCache, mediaRequirementIssues } from './media-requirements'

const videoModel: ModelSpec = {
  id: 'video-1',
  title: '示例视频模型',
  capabilities: ['video.generate'],
  limits: {
    media: {
      image: {
        mime: ['image/png'],
        maxMB: 30,
        minEdge: 256,
        maxEdge: 5760,
        minRatio: 0.4,
        maxRatio: 2.5,
      },
      video: {
        mime: ['video/mp4'],
        maxMB: 200,
        minEdge: 300,
        maxEdge: 6000,
        minDuration: 2,
        maxDuration: 15,
        totalDurationMax: 15,
        videoCodecs: ['h264', 'hevc'],
        minFrameRate: 24,
        maxFrameRate: 60,
        audioCodecs: ['aac', 'mp3'],
      },
      audio: { mime: ['audio/wav'], maxMB: 15, minDuration: 2, maxDuration: 15 },
      videoTasks: { edit: { minDuration: 4 } },
    },
  },
}

const assetId = 'a'.repeat(64)

/** 资产记录：只放宿主真正能拿到的字段 */
const asset = (over: Partial<Asset> = {}): Asset => ({
  id: assetId,
  kind: 'video',
  mime: 'video/mp4',
  name: '片头',
  size: 1024,
  width: 1280,
  height: 720,
  duration: 5,
  variants: [],
  createdAt: 0,
  ...over,
})

/** 只用到的宿主能力：查资产记录与探测媒体 */
const stubHost = (
  assets: Record<string, Asset>,
  probe?: (ref: AssetRef) => Promise<Record<string, unknown>>,
) =>
  ({
    assetInfo: (_ownerId: string, id: string) => assets[id],
    services: () => ({
      media: {
        probe: async (ref: AssetRef) => {
          if (!probe) throw new Error('本机没有 ffprobe')
          return (await probe(ref)) as never
        },
      },
    }),
  }) as unknown as PluginHost

/** 一段画布：素材元素名叫「片头」 */
const scene = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const element = createElement(doc, {
    kind: 'video',
    assetId,
    name: '片头',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  return { doc, element }
}

const videoInput = (): PortValue[] => [
  { type: 'video', assetId, kind: 'video', source: 'el1' } as PortValue,
]

const check = async (
  over: {
    assets?: Record<string, Asset>
    inputs?: Record<string, PortValue[]>
    params?: Record<string, unknown>
    probe?: (ref: AssetRef) => Promise<Record<string, unknown>>
  } = {},
) => {
  const { doc, element } = scene()
  const inputs = over.inputs ?? { videos: videoInput() }
  // 让画布上的元素能按名字找到
  for (const values of Object.values(inputs))
    for (const value of values) if ('source' in value) value.source = element
  return mediaRequirementIssues({
    host: stubHost(over.assets ?? { [assetId]: asset() }, over.probe),
    ownerId: 'local',
    doc,
    capability: 'video.generate',
    model: videoModel,
    params: { mode: 'reference', ...over.params },
    inputs,
    signal: new AbortController().signal,
  })
}

afterEach(() => {
  clearMediaProbeCache()
  vi.restoreAllMocks()
})

describe('运行前按模型声明检查送入的素材', () => {
  it('帧率不符时点名素材与模型', async () => {
    const issues = await check({
      assets: { [assetId]: asset() },
      probe: async () => ({ videoCodec: 'h264', frameRate: 20, audioCodecs: [] }),
    })
    expect(issues).toEqual([
      '参考视频「片头」帧率 20 fps，示例视频模型 要求 24–60 fps，请先转码再运行',
    ])
  })

  it('视频编码不符时给出可接受的编码', async () => {
    const issues = await check({
      probe: async () => ({ videoCodec: 'vp9', frameRate: 30, audioCodecs: [] }),
    })
    expect(issues[0]).toContain('编码 VP9')
    expect(issues[0]).toContain('示例视频模型')
  })

  it('单段时长与总时长超限时分别说清', async () => {
    expect(await check({ assets: { [assetId]: asset({ duration: 1 }) } })).toEqual([
      '参考视频「片头」只有 1 秒，示例视频模型 要求至少 2 秒，请换更长的素材',
    ])
    const long = await check({
      inputs: {
        videos: [
          { type: 'video', assetId, kind: 'video', source: 'el1' } as PortValue,
          { type: 'video', assetId: 'b'.repeat(64), kind: 'video', source: 'el1' } as PortValue,
        ],
      },
      assets: { [assetId]: asset({ duration: 10 }), ['b'.repeat(64)]: asset({ duration: 10 }) },
    })
    expect(long).toEqual(['参考视频总时长 20 秒，超过 示例视频模型 的 15 秒上限，请缩短素材'])
  })

  it('编辑参考视频按任务模式要求更长的素材', async () => {
    const issues = await check({
      assets: { [assetId]: asset({ duration: 3 }) },
      params: {
        model: 'volc/ark:doubao-seedance-2-5-260628',
        options: { 'volc/ark:doubao-seedance-2-5-260628': { omni_reference_task_type: 'edit' } },
      },
    })
    expect(issues).toEqual([
      '参考视频「片头」只有 3 秒，示例视频模型 要求至少 4 秒，请换更长的素材',
    ])
  })

  it('大小、宽高与格式不符时按素材逐条说明', async () => {
    const issues = await check({
      assets: {
        [assetId]: asset({ mime: 'video/webm', size: 300 * 1024 * 1024, width: 100, height: 100 }),
      },
    })
    expect(issues).toEqual([
      '参考视频「片头」格式 video/webm 不在允许范围（MP4），请先转换格式再运行',
      '参考视频「片头」大小 300 MB，超过 示例视频模型 的 200 MB 上限，请压缩后再运行',
      '参考视频「片头」 100×100，示例视频模型 要求宽高 300–6000 像素，请更换素材',
    ])
  })

  it('符合声明时放行', async () => {
    expect(
      await check({
        probe: async () => ({ videoCodec: 'h264', frameRate: 30, audioCodecs: ['aac'] }),
      }),
    ).toEqual([])
  })

  it('探测失败不阻断，交给运行期', async () => {
    expect(await check({ probe: undefined })).toEqual([])
  })

  it('资产记录里没有的信息不阻断', async () => {
    const issues = await check({
      assets: { [assetId]: asset({ width: undefined, height: undefined, duration: undefined }) },
      probe: undefined,
    })
    expect(issues).toEqual([])
  })

  it('模型没有声明素材要求时不检查', async () => {
    const { doc } = scene()
    const issues = await mediaRequirementIssues({
      host: stubHost({ [assetId]: asset({ mime: 'video/webm' }) }),
      ownerId: 'local',
      doc,
      capability: 'video.generate',
      model: { id: 'video-1', title: '示例视频模型', capabilities: ['video.generate'] },
      params: { mode: 'reference' },
      inputs: { videos: videoInput() },
      signal: new AbortController().signal,
    })
    expect(issues).toEqual([])
  })
})

describe('实际输入预览按模型声明挡住不合要求的素材', () => {
  const processSpec = mockProvider.models.find((m) => m.id === 'image-process')!
  const limits = processSpec.limits
  afterEach(() => {
    processSpec.limits = limits
  })

  it('精修原图宽高不够时在运行前说明', async () => {
    const { server } = await bootServer()
    mockSettings(server, {})
    const { id, doc } = await createCanvas(server)
    const small = await server.assets.ingest(
      'local',
      Readable.from([solidPng(300, 300, [80, 90, 100])]),
      {
        mime: 'image/png',
        name: '小图.png',
      },
    )
    const big = await server.assets.ingest(
      'local',
      Readable.from([solidPng(600, 600, [80, 90, 100])]),
      {
        mime: 'image/png',
        name: '大图.png',
      },
    )
    processSpec.limits = {
      ...limits,
      media: { process: { mime: ['image/png'], maxMB: 10, minEdge: 512, maxEdge: 4096 } },
    }
    const node = addNode(doc, 'plein/image-process', {
      params: { model: 'plein/mock:image-process', operation: 'upscale' },
    })
    const source = createElement(doc, {
      kind: 'image',
      assetId: small.id,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    connect(doc, [source, 'image'], [node, 'image'])
    const response = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
    const prepared = (await response.json()) as PreparedInput
    expect(prepared.status).toBe('blocked')
    expect(prepared.blocked?.map((issue) => issue.message)).toContain(
      '精修原图「小图.png」 300×300，Mock 图片精修 要求宽高 512–4096 像素，请更换素材',
    )

    // 换成符合要求的原图就放行
    const ok = createElement(doc, { kind: 'image', assetId: big.id, x: 0, y: 0, w: 100, h: 100 })
    connect(doc, [ok, 'image'], [node, 'image'])
    const allowed = await request(server, `/api/canvases/${id}/nodes/${node}/input`)
    const preparedOk = (await allowed.json()) as PreparedInput
    expect(preparedOk.status).toBe('ready')
    expect(preparedOk.blocked ?? []).toEqual([])
  })
})

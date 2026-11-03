import type { ModelLimits } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import {
  adaptToModel,
  constrainFields,
  modelProblem,
  type SelectedModel,
  selectedModel,
} from './modelParams'
import { fieldsOf, type NodeInfo, type Upstream } from './nodes'

const node = {
  type: 'plein/video',
  capability: 'video.generate',
  defaults: { model: '', duration: 5, aspectRatio: '16:9', resolution: '' },
  paramsSchema: {
    properties: {
      model: { type: 'string', widget: 'model' },
      duration: { type: 'integer', minimum: 1, maximum: 30, title: '时长' },
      count: { type: 'integer', minimum: 1, maximum: 4, title: '数量' },
      aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'], title: '画幅' },
      resolution: { type: 'string', widget: 'resolution' },
      seed: { type: 'integer' },
      options: { type: 'object', widget: 'modelOptions' },
    },
  },
} as unknown as NodeInfo

const catalog = {
  providers: [
    {
      id: 'p/a',
      enabled: true,
      configured: true,
      models: [
        {
          id: 'fast',
          title: 'Fast',
          capabilities: ['video.generate'],
          limits: {
            resolutions: ['480p', '720p'],
            duration: { min: 4, max: 15 },
            aspectRatios: ['16:9', '9:16'],
            seed: false,
          },
        },
        { id: 'free', title: 'Free', capabilities: ['video.generate' as const] },
      ],
    },
  ],
} as unknown as Catalog

describe('按模型处理参数', () => {
  it('没选模型时不替用户挑；按所选模型的约束收窄字段，不支持的去掉', () => {
    expect(selectedModel(catalog, node, { model: '' })).toBeUndefined()
    const m = selectedModel(catalog, node, { model: 'p/a:fast' })!
    expect(m.info.ref).toBe('p/a:fast')
    const fields = Object.fromEntries(constrainFields(node, fieldsOf(node), m.info.limits))
    expect(fields.duration).toMatchObject({ minimum: 4, maximum: 15 })
    expect(fields.aspectRatio?.enum).toEqual(['16:9', '9:16'])
    expect(fields.resolution?.enum).toEqual(['', '480p', '720p'])
    expect(fields.seed).toBeUndefined()
    expect(fields.options).toBeUndefined()
    // 没声明约束的模型：不显示分辨率，其余照旧
    const free = selectedModel(catalog, node, { model: 'p/a:free' })!
    const plain = Object.fromEntries(constrainFields(node, fieldsOf(node), free.info.limits))
    expect(plain.resolution).toBeUndefined()
    expect(plain.duration).toMatchObject({ minimum: 1, maximum: 30 })
  })

  it('换模型时校正不合法的取值并说明，提交前同样检查', () => {
    const params = {
      model: 'p/a:fast',
      prompt: '测试',
      duration: 3,
      aspectRatio: '1:1',
      resolution: '1080p',
    }
    const m = selectedModel(catalog, node, params)!.info
    const { patch, notes } = adaptToModel(node, params, m)
    expect(patch).toEqual({ duration: 4, aspectRatio: '16:9', resolution: '' })
    expect(notes).toHaveLength(3)
    expect(modelProblem(node, params, m, new Map())).toBe('Fast 的时长须为 4–15 秒，现在是 3 秒')
    expect(modelProblem(node, { ...params, ...patch }, m, new Map())).toBeNull()
  })

  it('分辨率、张数超限的说法与服务端一致：点名可选值、视频按条图片按张', () => {
    const m = selectedModel(catalog, node, { model: 'p/a:fast' })!.info
    expect(modelProblem(node, { resolution: '1080p' }, m, new Map())).toBe(
      'Fast 不支持分辨率 1080p；请选择 480p、720p，或使用默认分辨率',
    )
    // 模型没声明可选分辨率时只让用户恢复默认
    const plain: SelectedModel['info'] = {
      ref: 'p:free',
      id: 'free',
      title: 'Free',
      capabilities: ['video.generate'],
      limits: {},
    }
    expect(modelProblem(node, { resolution: '4k' }, plain, new Map())).toBe(
      'Free 不支持分辨率 4k；或使用默认分辨率',
    )
    const two = { ...m, limits: { ...m.limits, count: { max: 2 } } }
    expect(modelProblem(node, { count: 3 }, two, new Map())).toBe('Fast 一次最多生成 2 条')
  })
})

describe('配音参数', () => {
  const speech = {
    type: 'plein/speech',
    capability: 'audio.speech',
    defaults: { model: '', speed: 1 },
    paramsSchema: {
      properties: {
        model: { type: 'string', widget: 'model' },
        speed: { type: 'number', minimum: 0.5, maximum: 2, title: '语速' },
        instruction: { type: 'string', title: '语气指令' },
      },
    },
  } as unknown as NodeInfo

  it('不支持语速、语气指令的模型隐藏它们；语速超出范围时校正', () => {
    const none = Object.fromEntries(
      constrainFields(speech, fieldsOf(speech), { speed: false, instruction: false }),
    )
    expect(Object.keys(none)).toEqual(['model'])
    const { patch, notes } = adaptToModel(
      speech,
      { speed: 3 },
      {
        ref: 'p:x',
        id: 'x',
        title: 'X',
        capabilities: ['audio.speech'],
        limits: { speed: { min: 0.5, max: 2 } },
      },
    )
    expect(patch).toEqual({ speed: 2 })
    expect(notes[0]).toBe('语速已从 3 倍改为 2 倍（X 支持 0.5–2 倍）')
  })

  it('模型不支持语速时把旧语速恢复为默认并说明', () => {
    const m: SelectedModel['info'] = {
      ref: 'p:x',
      id: 'x',
      title: 'X',
      capabilities: ['audio.speech'],
      limits: { speed: false },
    }
    const { patch, notes } = adaptToModel(speech, { speed: 1.5 }, m)
    expect(patch).toEqual({ speed: 1 })
    expect(notes).toEqual(['语速已恢复默认（X 不支持调节语速）'])
    // 已经是默认语速就不动
    expect(adaptToModel(speech, { speed: 1 }, m)).toEqual({ patch: {}, notes: [] })
    // 提交前同样提示
    expect(modelProblem(speech, { speed: 1.5 }, m, new Map())).toBe(
      'X 不支持调节语速，请把语速恢复为 1',
    )
    expect(modelProblem(speech, { speed: 1 }, m, new Map())).toBeNull()
  })

  it('模型不支持时长、生成音频时只由平台决定，不改值也不说明', () => {
    const videoNode = {
      type: 'plein/video',
      capability: 'video.generate',
      defaults: { model: '', duration: 5, audio: true },
      paramsSchema: {
        properties: {
          model: { type: 'string', widget: 'model' },
          duration: { type: 'integer', minimum: 1, maximum: 30, title: '时长' },
          audio: { type: 'boolean', title: '生成音频', widget: 'audio' },
        },
      },
    } as unknown as NodeInfo
    const m: SelectedModel['info'] = {
      ref: 'p:x',
      id: 'x',
      title: 'X',
      capabilities: ['video.generate'],
      limits: { duration: false, audio: false },
    }
    expect(adaptToModel(videoNode, { duration: 5, audio: true }, m)).toEqual({
      patch: {},
      notes: [],
    })
  })
})

describe('张数、参考图与画幅', () => {
  const imageNode = {
    type: 'plein/image',
    capability: 'image.generate',
    defaults: { model: '', count: 1, aspectRatio: 'auto' },
    paramsSchema: {
      properties: {
        model: { type: 'string', widget: 'model' },
        count: { type: 'integer', minimum: 1, maximum: 4, title: '张数' },
        aspectRatio: { type: 'string', enum: ['auto', '16:9', '1:1'], title: '画幅' },
      },
    },
  } as unknown as NodeInfo
  const model = (limits: ModelLimits): SelectedModel['info'] => ({
    ref: 'p:x',
    id: 'x',
    title: 'X',
    capabilities: ['image.generate'],
    limits,
  })
  const refs = (n: number, port = 'references') =>
    new Map([[port, Array.from({ length: n }, () => ({}) as Upstream)]])

  it('张数上限收窄字段，上限只有 1 张时不显示；超出时改到上限', () => {
    const two = Object.fromEntries(
      constrainFields(imageNode, fieldsOf(imageNode), { count: { max: 2 } }),
    )
    expect(two.count).toMatchObject({ minimum: 1, maximum: 2 })
    const one = Object.fromEntries(
      constrainFields(imageNode, fieldsOf(imageNode), { count: { max: 1 } }),
    )
    expect(one.count).toBeUndefined()
    const params = { count: 4, aspectRatio: '16:9' }
    const m = model({ count: { max: 2 } })
    expect(adaptToModel(imageNode, params, m)).toEqual({
      patch: { count: 2 },
      notes: ['张数已改为 2（X 最多 2 张）'],
    })
    expect(modelProblem(imageNode, params, m, new Map())).toBe('X 一次最多生成 2 张')
  })

  it('智能画幅要模型明确声明支持', () => {
    const plain = Object.fromEntries(constrainFields(imageNode, fieldsOf(imageNode), {}))
    expect(plain.aspectRatio?.enum).toEqual(['16:9', '1:1'])
    const { patch, notes } = adaptToModel(imageNode, { aspectRatio: 'auto' }, model({}))
    expect(patch).toEqual({ aspectRatio: '16:9' })
    expect(notes).toEqual(['画幅已从 智能 改为 16:9（X 不支持 智能）'])
    const auto = model({ aspectRatios: ['auto', '1:1'] })
    expect(adaptToModel(imageNode, { aspectRatio: 'auto' }, auto).patch).toEqual({})
    expect(modelProblem(imageNode, { aspectRatio: 'auto' }, model({}), new Map())).toBe(
      'X 不支持画幅 auto',
    )
  })

  it('参考图超过模型上限时说明连了几张', () => {
    const m = model({ references: { max: 2 } })
    const params = { aspectRatio: '16:9' }
    expect(modelProblem(imageNode, params, m, refs(2))).toBeNull()
    expect(modelProblem(imageNode, params, m, refs(3))).toBe('X 最多支持 2 张参考图，现在连了 3 张')
  })

  it('生成视频：连入图片数要和模式对得上；只有图片参考模式按参考图计数', () => {
    const m = { ...model({ references: { max: 1 } }), capabilities: ['video.generate' as const] }
    const params = { model: '', prompt: '测试', duration: 5, aspectRatio: '16:9' }
    // 没选到模型也先查模式
    expect(modelProblem(node, { ...params, mode: 'image' }, undefined, new Map())).toBe(
      '图生视频需要连入 1 张图作首帧',
    )
    expect(modelProblem(node, { ...params, mode: 'frames' }, m, refs(1, 'images'))).toMatch(
      /^首尾帧需要连入 2 张图/,
    )
    expect(modelProblem(node, { ...params, mode: 'frames' }, m, refs(2, 'images'))).toBeNull()
    expect(modelProblem(node, { ...params, mode: 'reference' }, m, refs(2, 'images'))).toBe(
      'X 最多支持 1 张参考图，现在连了 2 张',
    )
  })
})

it('仅尾帧模式在前端要求恰好一张图片，禁止混入视频或音频', () => {
  const params = { mode: 'lastFrame' }
  expect(modelProblem(node, params, undefined, new Map())).toContain('仅尾帧')
  const images = [{} as Upstream]
  expect(modelProblem(node, params, undefined, new Map([['images', images]]))).toBeNull()
  expect(
    modelProblem(node, params, undefined, new Map([['images', [...images, ...images]]])),
  ).toContain('仅尾帧')
  expect(
    modelProblem(
      node,
      params,
      undefined,
      new Map([
        ['images', images],
        ['audios', images],
      ]),
    ),
  ).toContain('多模态参考模式')
})

it('最终素材编号交给服务端校验，避免误拦由角色软引用补入的图', () => {
  const m: SelectedModel['info'] = {
    id: 'm',
    ref: 'p:m',
    title: 'M',
    capabilities: ['video.generate'],
    limits: { references: { max: 9 }, aspectRatios: ['16:9'] },
  }
  const params = {
    mode: 'reference',
    prompt: '@林夏 站在 @image2 中',
    aspectRatio: '16:9',
    duration: 5,
  }
  expect(modelProblem(node, params, m, new Map([['images', [{} as Upstream]]]))).toBeNull()
})

describe('参考视频 / 音频的上限提示按类型区分', () => {
  const videoModel = (referenceMedia?: {
    video: number
    audio: number
  }): SelectedModel['info'] => ({
    id: 'm',
    ref: 'p:m',
    title: 'M',
    capabilities: ['video.generate'],
    limits: { references: { max: 9 }, ...(referenceMedia ? { referenceMedia } : {}) },
  })
  const params = { mode: 'reference', aspectRatio: '16:9', duration: 5 }
  const media = (port: 'videos' | 'audios', n: number) =>
    new Map([[port, Array.from({ length: n }, () => ({}) as Upstream)]])

  it('模型不支持某类参考时点名说；超过上限时说明上限与实际连了多少', () => {
    expect(modelProblem(node, params, videoModel(), media('videos', 1))).toBe(
      '当前模型不支持参考视频',
    )
    expect(modelProblem(node, params, videoModel(), media('audios', 1))).toBe(
      '当前模型不支持参考音频',
    )
    expect(modelProblem(node, params, videoModel({ video: 2, audio: 1 }), media('videos', 3))).toBe(
      '当前模型最多支持 2 段参考视频，现在连了 3 段',
    )
    expect(modelProblem(node, params, videoModel({ video: 2, audio: 1 }), media('audios', 2))).toBe(
      '当前模型最多支持 1 段参考音频，现在连了 2 段',
    )
  })

  it('视频先判：两类都超限时先说视频', () => {
    const ups = new Map([
      ['videos', Array.from({ length: 3 }, () => ({}) as Upstream)],
      ['audios', Array.from({ length: 2 }, () => ({}) as Upstream)],
    ])
    expect(modelProblem(node, params, videoModel({ video: 2, audio: 1 }), ups)).toBe(
      '当前模型最多支持 2 段参考视频，现在连了 3 段',
    )
  })

  it('模型声明之外的视频模式先点名模式：写清模型、模式中文名和怎么办', () => {
    const modes = (
      list: Array<'text' | 'image' | 'lastFrame' | 'frames' | 'reference'>,
    ): SelectedModel['info'] => ({ ...videoModel(), limits: { videoModes: list } })
    expect(modelProblem(node, { ...params, mode: 'frames' }, modes(['text']), new Map())).toBe(
      'M 不支持「首尾帧」模式，请更换模式或模型',
    )
    expect(modelProblem(node, { ...params, mode: 'text' }, modes(['text']), new Map())).toBeNull()
  })
})

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
            defaultResolution: '720p',
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
    expect(fields.resolution?.labels?.['']).toBe('默认（720p）')
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
    expect(modelProblem(node, { prompt: '海边日落', resolution: '1080p' }, m, new Map())).toBe(
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
    expect(modelProblem(node, { prompt: '海边日落', resolution: '4k' }, plain, new Map())).toBe(
      'Free 不支持分辨率 4k；或使用默认分辨率',
    )
    const two = { ...m, limits: { ...m.limits, count: { max: 2 } } }
    expect(modelProblem(node, { prompt: '海边日落', count: 3 }, two, new Map())).toBe(
      'Fast 一次最多生成 2 条',
    )
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

describe('对话模型看图', () => {
  const llmNode = {
    type: 'plein/llm',
    capability: 'text.chat',
    defaults: { model: '' },
    paramsSchema: { properties: { model: { type: 'string', widget: 'model' } } },
  } as unknown as NodeInfo
  const blind: SelectedModel['info'] = {
    ref: 'p:blind',
    id: 'blind',
    title: 'Blind',
    capabilities: ['text.chat'],
    features: [],
  }
  const images = [{} as Upstream]

  it('连了图片但模型未声明 vision 时先说明；支持看图或没连图不拦', () => {
    expect(modelProblem(llmNode, {}, blind, new Map([['images', images]]))).toBe(
      'Blind 不支持看图，请换支持图片的模型或断开图片输入',
    )
    expect(
      modelProblem(llmNode, {}, { ...blind, features: ['vision'] }, new Map([['images', images]])),
    ).toBeNull()
    expect(modelProblem(llmNode, {}, blind, new Map())).toBeNull()
  })
})

describe('对话模型温度', () => {
  const llm = {
    type: 'plein/llm',
    capability: 'text.chat',
    defaults: { model: '', temperature: 0.7 },
    paramsSchema: {
      properties: {
        model: { type: 'string', widget: 'model' },
        temperature: { type: 'number', minimum: 0, maximum: 2, title: '温度', default: 0.7 },
      },
    },
  } as unknown as NodeInfo

  it('推理模型不支持调温：表单隐藏温度，换过来时说明已忽略', () => {
    const fields = Object.fromEntries(constrainFields(llm, fieldsOf(llm), { temperature: false }))
    expect(fields.temperature).toBeUndefined()
    const m: SelectedModel['info'] = {
      ref: 'openai/api:gpt-6-astra',
      id: 'gpt-6-astra',
      title: 'gpt-6-astra',
      capabilities: ['text.chat'],
      limits: { temperature: false },
    }
    // 值保留不恢复默认：换回支持调温的模型时还在
    expect(adaptToModel(llm, { temperature: 1.2 }, m)).toEqual({
      patch: {},
      notes: ['gpt-6-astra 不支持调节温度，已忽略'],
    })
    // 本来就是默认温度就没有可忽略的取值
    expect(adaptToModel(llm, {}, m)).toEqual({ patch: {}, notes: [] })
  })
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
    expect(
      modelProblem(
        node,
        { ...params, mode: 'text', prompt: '海边日落' },
        modes(['text']),
        new Map(),
      ),
    ).toBeNull()
  })

  it('Seedance 2.5 勾选草稿模式时分辨率收敛到 480p，提交前给出提示', () => {
    const seedance: SelectedModel['info'] = {
      ref: 'volc/ark:doubao-seedance-2-5-260628',
      id: 'doubao-seedance-2-5-260628',
      title: 'Seedance 2.5',
      capabilities: ['video.generate'],
      limits: { resolutions: ['480p', '720p', '1080p'] },
    }
    const draft = (resolution: unknown) => ({
      model: seedance.ref,
      mode: 'text',
      prompt: '海边日落',
      resolution,
      options: { [seedance.ref]: { draft: true } },
    })
    expect(adaptToModel(node, draft('1080p'), seedance)).toEqual({
      patch: { resolution: '480p' },
      notes: ['分辨率已改为 480p（当前设置下平台只接受这一档）'],
    })
    // 分辨率留空（跟平台默认）也拦：默认不是 480p
    expect(adaptToModel(node, draft(''), seedance).patch).toEqual({ resolution: '480p' })
    // 已是 480p 就不动；没勾草稿不收敛；非 Seedance 2.5 不收敛
    expect(adaptToModel(node, draft('480p'), seedance)).toEqual({ patch: {}, notes: [] })
    expect(adaptToModel(node, { ...draft('1080p'), options: {} }, seedance)).toEqual({
      patch: {},
      notes: [],
    })
    expect(
      adaptToModel(node, draft('1080p'), {
        ...seedance,
        id: 'doubao-seedance-2-0-260128',
        ref: 'volc/ark:doubao-seedance-2-0-260128',
      }),
    ).toEqual({ patch: {}, notes: [] })
    expect(modelProblem(node, draft('1080p'), seedance, new Map())).toBe(
      '草稿模式只支持 480p，当前是 1080p',
    )
    expect(modelProblem(node, draft(''), seedance, new Map())).toBe(
      '草稿模式只支持 480p，当前是 默认分辨率',
    )
    expect(modelProblem(node, draft('480p'), seedance, new Map())).toBeNull()
  })
})

describe('图片精修参数', () => {
  const processNode = {
    type: 'plein/image-process',
    capability: 'image.process',
    defaults: {
      model: '',
      operation: 'upscale',
      scale: 2,
      top: 1,
      bottom: 1,
      left: 1.5,
      right: 1.5,
    },
    paramsSchema: {
      properties: {
        model: { type: 'string', widget: 'model' },
        operation: {
          type: 'string',
          enum: ['upscale', 'outpaint', 'cutout'],
          title: '操作',
        },
        scale: { type: 'number', minimum: 1, maximum: 4, title: '放大倍数' },
        top: { type: 'number', minimum: 1, maximum: 2, title: '向上扩展比例' },
        bottom: { type: 'number', minimum: 1, maximum: 2, title: '向下扩展比例' },
        left: { type: 'number', minimum: 1, maximum: 2, title: '向左扩展比例' },
        right: { type: 'number', minimum: 1, maximum: 2, title: '向右扩展比例' },
      },
    },
  } as unknown as NodeInfo
  const model = {
    ref: 'aliyun/bailian:wanx2.1-imageedit',
    id: 'wanx2.1-imageedit',
    title: '万相图像编辑',
    capabilities: ['image.edit', 'image.process'],
    limits: {
      imageOperations: ['upscale', 'outpaint'],
      process: { scale: { min: 1, max: 3 }, expansion: { min: 1, max: 2 } },
    },
  } as unknown as SelectedModel['info']

  it('按声明收窄放大倍数，操作只保留模型支持的', () => {
    const fields = Object.fromEntries(
      constrainFields(processNode, fieldsOf(processNode), model.limits),
    )
    expect(fields.scale).toMatchObject({ minimum: 1, maximum: 3 })
    expect(fields.operation?.enum).toEqual(['upscale', 'outpaint'])
  })

  it('超出声明范围时说明模型、范围和当前值', () => {
    expect(modelProblem(processNode, { operation: 'upscale', scale: 5 }, model, new Map())).toBe(
      '万相图像编辑 放大倍数须为 1–3，现在是 5',
    )
    expect(
      modelProblem(processNode, { operation: 'upscale', scale: 3 }, model, new Map()),
    ).toBeNull()
  })
})

describe('视频参数随当前设置收窄', () => {
  const videoNode = {
    type: 'plein/video',
    capability: 'video.generate',
    defaults: { model: '', mode: 'text', aspectRatio: '16:9', resolution: '' },
    paramsSchema: {
      properties: {
        model: { type: 'string', widget: 'model' },
        mode: { type: 'string', enum: ['text', 'image', 'reference'] },
        aspectRatio: { type: 'string', enum: ['auto', '16:9', '9:16'], title: '画幅' },
        resolution: { type: 'string', widget: 'resolution' },
        options: { type: 'object', widget: 'modelOptions' },
      },
    },
  } as unknown as NodeInfo
  const fieldOf = (
    fields: ReturnType<typeof constrainFields>,
    key: string,
  ): { enum?: unknown[] } | undefined => fields.find(([k]) => k === key)?.[1]
  const all = () => fieldsOf(videoNode)

  const h3 = (id: string): SelectedModel['info'] => ({
    ref: `minimax/api:${id}`,
    id,
    title: id,
    capabilities: ['video.generate'],
    limits: {
      aspectRatios: ['auto', '16:9', '9:16'],
      videoModes: ['text', 'image', 'reference'],
    },
  })

  it('文生视频与 H3-Lite 参考模式的画幅选项去掉 auto，其余模式保留', () => {
    const pro = h3('MiniMax-H3')
    const lite = h3('MiniMax-H3-Lite')
    const options = (m: SelectedModel['info'], mode: string) =>
      fieldOf(
        constrainFields(videoNode, all(), m.limits, { model: m.ref, mode }, 0, m),
        'aspectRatio',
      )?.enum
    expect(options(pro, 'text')).toEqual(['16:9', '9:16'])
    expect(options(pro, 'reference')).toEqual(['auto', '16:9', '9:16'])
    expect(options(lite, 'reference')).toEqual(['16:9', '9:16'])
    // 图生视频由平台按首帧决定画幅，字段本身隐藏
    expect(options(pro, 'image')).toBeUndefined()
  })

  it('换到不接受 auto 的模式时把画幅纠正为具体值', () => {
    const pro = h3('MiniMax-H3')
    const params = { model: pro.ref, mode: 'text', aspectRatio: 'auto', prompt: 'x' }
    const { patch, notes } = adaptToModel(videoNode, params, pro)
    expect(patch).toEqual({ aspectRatio: '16:9' })
    expect(notes[0]).toContain('画幅已从')
    // 图生视频本来就接受 auto，不动
    expect(adaptToModel(videoNode, { ...params, mode: 'image' }, pro).patch).toEqual({})
  })

  it('Seedance 2.5 勾选草稿后分辨率枚举只剩平台接受的值，且不再提供「默认」', () => {
    const seedance: SelectedModel['info'] = {
      ref: 'volc/ark:doubao-seedance-2-5-260628',
      id: 'doubao-seedance-2-5-260628',
      title: 'Seedance 2.5',
      capabilities: ['video.generate'],
      limits: { resolutions: ['480p', '720p', '1080p'], defaultResolution: '720p' },
    }
    const resolutionEnum = (options: Record<string, unknown>) =>
      fieldOf(
        constrainFields(
          videoNode,
          all(),
          seedance.limits,
          { model: seedance.ref, mode: 'text', options: { [seedance.ref]: options } },
          0,
          seedance,
        ),
        'resolution',
      )?.enum
    expect(resolutionEnum({ draft: true })).toEqual(['480p'])
    expect(resolutionEnum({})).toEqual(['', '480p', '720p', '1080p'])
  })
})

describe('图片种子字段', () => {
  const imageNode = {
    type: 'plein/image',
    capability: 'image.generate',
    defaults: { model: '' },
    paramsSchema: {
      properties: {
        model: { type: 'string', widget: 'model' },
        seed: { type: 'integer', title: '种子', minimum: 0 },
      },
    },
  } as unknown as NodeInfo
  const keys = (limits: ModelLimits) =>
    constrainFields(imageNode, fieldsOf(imageNode), limits).map(([k]) => k)

  it('只有模型声明了种子才显示，声明范围时范围收窄到声明内', () => {
    expect(keys({})).not.toContain('seed')
    expect(keys({ seed: false })).not.toContain('seed')
    expect(keys({ seed: true })).toContain('seed')
    const field = constrainFields(imageNode, fieldsOf(imageNode), {
      seed: { min: 1, max: 99 },
    }).find(([k]) => k === 'seed')![1]
    expect([field.minimum, field.maximum]).toEqual([1, 99])
  })
})

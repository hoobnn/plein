import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vitest'
import { adaptToModel, constrainFields, modelProblem, selectedModel } from './modelParams'
import { fieldsOf, type NodeInfo } from './nodes'

const node = {
  type: 'plein/video',
  capability: 'video.generate',
  defaults: { model: '', duration: 5, aspectRatio: '16:9', resolution: '' },
  paramsSchema: {
    properties: {
      model: { type: 'string', widget: 'model' },
      duration: { type: 'integer', minimum: 1, maximum: 30, title: '时长' },
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
        { id: 'free', title: 'Free', capabilities: ['video.generate'] },
      ],
    },
  ],
} as unknown as Catalog

describe('按模型处理参数', () => {
  it('自动选择取第一个模型；按约束收窄字段，不支持的去掉', () => {
    const m = selectedModel(catalog, node, { model: '' })!
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
    const params = { model: 'p/a:fast', duration: 3, aspectRatio: '1:1', resolution: '1080p' }
    const m = selectedModel(catalog, node, params)!.info
    const { patch, notes } = adaptToModel(node, params, m)
    expect(patch).toEqual({ duration: 4, aspectRatio: '16:9', resolution: '' })
    expect(notes).toHaveLength(3)
    expect(modelProblem(node, params, m, new Map())).toBe('Fast 的时长须为 4–15 秒')
    expect(modelProblem(node, { ...params, ...patch }, m, new Map())).toBeNull()
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
})

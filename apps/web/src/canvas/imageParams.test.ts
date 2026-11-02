import { describe, expect, it } from 'vite-plus/test'
import { type ModelSpec, describeNode } from '@plein/plugin-sdk'
import { imageNode } from '@plein/nodes'
import { arkProvider, bailianProvider, minimaxProvider } from '../../../../packages/providers/src'
import { constrainFields, modelProblem, adaptToModel } from './modelParams'
import { fieldsOf, type NodeInfo, type Upstream } from './nodes'

const node = describeNode(imageNode, 'plein/core') as NodeInfo
const refs = (n: number) =>
  new Map([['references', Array.from({ length: n }, () => ({}) as Upstream)]])
function model(provider: { id: string; models: ModelSpec[] }, id: string) {
  const spec = provider.models.find((m) => m.id === id)!
  return { ...spec, ref: `${provider.id}:${id}` }
}

describe('真实图片目录驱动界面参数', () => {
  it.each([
    [minimaxProvider, 'image-01', 9],
    [minimaxProvider, 'image-01-live', 9],
    [bailianProvider, 'qwen-image-3.0-pro', 6],
    [bailianProvider, 'wan2.7-image-pro', 4],
    [arkProvider, 'doubao-seedream-5-0-260128', 15],
  ] as const)('%s %s 开放官方张数上限 %i', (provider, id, max) => {
    const m = model(provider, id)
    const fields = Object.fromEntries(
      constrainFields(node, fieldsOf(node), m.limits, { model: m.ref }),
    )
    expect(fields.count?.maximum).toBe(max)
    expect(imageNode.params.safeParse({ model: m.ref, count: max, prompt: 'p' }).success).toBe(true)
    expect(
      modelProblem(node, { model: m.ref, count: max, aspectRatio: '16:9' }, m, refs(0)),
    ).toBeNull()
    expect(modelProblem(node, { model: m.ref, count: max + 1 }, m, refs(0))).toContain('最多')
  })

  it('Wan 参考图与组图模式收窄 4K，组图显示十二张，旧 4K 值提交前阻断', () => {
    const m = model(bailianProvider, 'wan2.7-image-pro')
    const params = { model: m.ref, resolution: '4K', aspectRatio: '16:9', count: 1 }
    const fields = (p: Record<string, unknown> = params, references = 0) =>
      Object.fromEntries(constrainFields(node, fieldsOf(node), m.limits, p, references))
    expect(fields().resolution?.enum).toContain('4K')
    expect(fields(params, 1).resolution?.enum).not.toContain('4K')
    const sequential = { ...params, options: { [m.ref]: { enable_sequential: true } } }
    expect(fields(sequential).resolution?.enum).not.toContain('4K')
    expect(fields(sequential).count?.maximum).toBe(12)
    expect(modelProblem(node, params, m, refs(1))).toContain('不支持分辨率 4K')
    expect(adaptToModel(node, params, m, 1).patch).toMatchObject({ resolution: '' })
  })

  it('MiniMax 1K 超宽组合从选项中去掉；live 不显示自定义分辨率或 21:9', () => {
    const m = model(minimaxProvider, 'image-01')
    const params = { model: m.ref, resolution: '1K', aspectRatio: '21:9' }
    const fields = Object.fromEntries(constrainFields(node, fieldsOf(node), m.limits, params))
    expect(fields.resolution?.enum).toEqual(['', '2K'])
    expect(modelProblem(node, params, m, refs(0))).toContain('不支持分辨率 1K')
    const live = model(minimaxProvider, 'image-01-live')
    const liveFields = Object.fromEntries(constrainFields(node, fieldsOf(node), live.limits))
    expect(liveFields.resolution).toBeUndefined()
    expect(liveFields.aspectRatio?.enum).not.toContain('21:9')
  })

  it('Lite 的参考图与输出合计上限同时控制字段和提交', () => {
    const m = model(arkProvider, 'doubao-seedream-5-0-260128')
    const params = { model: m.ref, count: 6 }
    const fields = Object.fromEntries(constrainFields(node, fieldsOf(node), m.limits, params, 10))
    expect(fields.count?.maximum).toBe(5)
    expect(modelProblem(node, params, m, refs(10))).not.toBeNull()
    expect(modelProblem(node, { ...params, count: 5 }, m, refs(10))).toBeNull()
  })
})

it('有效自定义尺寸覆盖旧画幅和分辨率，界面隐藏被覆盖字段', () => {
  const m = model(bailianProvider, 'qwen-image-3.0-pro')
  const params = {
    model: m.ref,
    aspectRatio: 'auto',
    resolution: '4K',
    options: { [m.ref]: { size: '2048*1024' } },
  }
  const fields = Object.fromEntries(constrainFields(node, fieldsOf(node), m.limits, params))
  expect(fields.resolution).toBeUndefined()
  expect(fields.aspectRatio).toBeUndefined()
  expect(modelProblem(node, params, m, refs(0))).toBeNull()
  expect(adaptToModel(node, params, m).patch).toEqual({})
})

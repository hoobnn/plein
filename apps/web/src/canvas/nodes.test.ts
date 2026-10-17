import type { Engine } from '@plein/canvas-core'
import {
  addResults,
  type CanvasElement,
  connect,
  createDoc,
  createElement,
  moveElements,
  reorderInputs,
} from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { type NodeInfo, nodeElement, type Upstream, upstreams, validate } from './nodes'

type PortDecl = { id: string; label: string; type: string; multiple?: boolean; required?: boolean }

/** 最小节点声明 */
const info = (over: Record<string, unknown> = {}) =>
  ({
    type: 'plein/image',
    version: 1,
    title: '生成图片',
    capability: 'image.generate',
    executable: true,
    defaults: {},
    paramsSchema: {
      properties: {
        prompt: { type: 'string', widget: 'textarea', title: '提示词' },
        count: { type: 'integer', minimum: 1, maximum: 4, title: '张数' },
        style: { type: 'string', enum: ['写实', '动画'], title: '风格' },
      },
    },
    inputs: [
      { id: 'prompt', label: '提示词', type: 'text', multiple: true },
      { id: 'references', label: '参考图', type: 'image', multiple: true },
    ] as PortDecl[],
    outputs: [{ id: 'images', label: '图片', type: 'image' }] as PortDecl[],
    ...over,
  }) as unknown as NodeInfo

const image = info()
/** 文本卡：就地计算，参数即结果 */
const textCard = info({
  type: 'plein/text',
  title: '文本',
  execution: 'inline',
  capability: undefined,
  paramsSchema: { properties: { text: { type: 'string', widget: 'textarea' } } },
  inputs: [],
  outputs: [{ id: 'text', label: '文本', type: 'text' }],
})
/** 资产卡：就地计算，输出连入的参考图 */
const character = info({
  type: 'plein/character',
  title: '角色',
  execution: 'inline',
  capability: undefined,
  paramsSchema: { properties: {} },
  inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
  outputs: [{ id: 'image', label: '图片', type: 'image' }],
})

const provider = (over: Record<string, unknown> = {}) => ({
  id: 'p',
  enabled: true,
  configured: true,
  models: [{ id: 'm', title: 'M', capabilities: ['image.generate'] }],
  ...over,
})
const catalogOf = (...providers: unknown[]) =>
  ({ nodes: [image, textCard, character], providers }) as unknown as Catalog

const el = (params: Record<string, unknown>) =>
  ({ id: 'n', kind: 'node', params }) as unknown as CanvasElement
const up = (name: string, value?: Upstream['value']): Upstream => ({
  edgeId: `e-${name}`,
  source: { id: name, kind: 'node', name } as unknown as CanvasElement,
  value,
})
const ups = (entries: Record<string, Upstream[]> = {}) => new Map(Object.entries(entries))
const ok = { prompt: '一只猫' }

describe('运行前校验', () => {
  it('纯节点不用校验；没有执行器的节点不能跑', () => {
    expect(validate(textCard, el({}), ups(), null)).toBeNull()
    expect(validate(info({ executable: false }), el(ok), ups(), null)).toBe('这个节点还没有执行器')
  })

  it('没有启用且配置好、支持该能力的平台时提示去设置', () => {
    const msg = '没有启用支持这个能力的平台，请先在设置里配置'
    expect(validate(image, el(ok), ups(), catalogOf(provider({ enabled: false })))).toBe(msg)
    expect(validate(image, el(ok), ups(), catalogOf(provider({ configured: false })))).toBe(msg)
    const other = provider({ models: [{ id: 'v', capabilities: ['video.generate'] }] })
    expect(validate(image, el(ok), ups(), catalogOf(other))).toBe(msg)
    expect(validate(image, el(ok), ups(), catalogOf(other, provider()))).toBeNull()
  })

  it.each([
    [{ count: 'abc' }, '参数「张数」应为数字'],
    [{ count: 1.5 }, '参数「张数」应为整数'],
    [{ count: 0 }, '参数「张数」应在 1–4 之间'],
    [{ count: 5 }, '参数「张数」应在 1–4 之间'],
    [{ style: '油画' }, '参数「风格」的值「油画」不在可选范围内'],
  ])('参数越界：%o', (params, msg) => {
    expect(validate(image, el({ ...ok, ...params }), ups(), null)).toBe(msg)
  })

  it('空参数跳过 schema 检查，合法值通过', () => {
    expect(validate(image, el({ ...ok, count: '', style: null }), ups(), null)).toBeNull()
    expect(validate(image, el({ ...ok, count: '4', style: '动画' }), ups(), null)).toBeNull()
  })

  it('必填端口没连、上游还没结果时说明是哪个', () => {
    const required = info({
      inputs: [{ id: 'references', label: '参考图', type: 'image', required: true }],
    })
    expect(validate(required, el(ok), ups(), null)).toBe('需要连入参考图')
    const pending = ups({ references: [up('A', { type: 'image', assetId: 'x' }), up('B')] })
    expect(validate(image, el(ok), pending, null)).toBe('上游「B」还没有结果')
  })

  it('提示词为空时，上游有非空文本也算填了', () => {
    expect(validate(image, el({}), ups(), null)).toBe('填写提示词，或连入上游文本')
    const blank = ups({ prompt: [up('T', { type: 'text', text: '  ' })] })
    expect(validate(image, el({ prompt: ' ' }), blank, null)).toBe('填写提示词，或连入上游文本')
    const text = ups({ prompt: [up('T', { type: 'text', text: '雨夜' })] })
    expect(validate(image, el({}), text, null)).toBeNull()
    // 没有文本输入端口时只能自己填
    expect(validate(info({ inputs: [] }), el({}), ups(), null)).toBe('填写提示词')
  })
})

describe('上游', () => {
  const setup = () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const engine = { doc } as unknown as Engine
    const at = (x: number, y: number) => ({ x, y, w: 100, h: 100 })
    const target = createElement(doc, { ...nodeElement(image), ...at(500, 0) })
    const md = (text: string, x: number, y: number) =>
      createElement(doc, { kind: 'markdown', text, ...at(x, y) })
    return { doc, engine, at, target, md }
  }

  it('按显式输入顺序读取，移动来源不改变顺序，重排立即生效', () => {
    const { doc, engine, target, md } = setup()
    const sources: string[] = [],
      edges: string[] = []
    for (const [text, x, y] of [
      ['下', 0, 200],
      ['右上', 100, 0],
      ['左上', 0, 0],
    ] as const) {
      const source = md(text, x, y)
      sources.push(source)
      edges.push(connect(doc, [source, 'text'], [target, 'prompt'])!.id)
    }
    const texts = () =>
      upstreams(engine, target, null)
        .get('prompt')!
        .map((u) => (u.value?.type === 'text' ? u.value.text : null))
    expect(texts()).toEqual(['下', '右上', '左上'])
    moveElements(doc, [sources[0]!], 0, -1000)
    expect(texts()).toEqual(['下', '右上', '左上'])
    reorderInputs(doc, [target, 'prompt'], [...edges].reverse())
    expect(texts()).toEqual(['左上', '右上', '下'])
  })

  it('素材元素给资产，节点给当前结果，非纯节点没结果时为空', () => {
    const { doc, engine, at, target } = setup()
    const img = createElement(doc, { kind: 'image', assetId: 'a1', ...at(0, 0) })
    const done = createElement(doc, { ...nodeElement(image), ...at(0, 200) })
    addResults(doc, done, [
      { id: 'r', port: 'images', value: { type: 'image', assetId: 'a2' }, runId: 'run', at: 1 },
    ])
    const idle = createElement(doc, { ...nodeElement(image), name: '没跑', ...at(0, 400) })
    connect(doc, [img, 'image'], [target, 'references'])
    connect(doc, [done, 'images'], [target, 'references'])
    connect(doc, [idle, 'images'], [target, 'references'])
    expect(
      upstreams(engine, target, catalogOf())
        .get('references')!
        .map((u) => u.value),
    ).toEqual([{ type: 'image', assetId: 'a1' }, { type: 'image', assetId: 'a2' }, undefined])
  })

  it('纯节点没有结果时就地取值：文本卡取文字，资产卡取它的第一张参考图', () => {
    const { doc, engine, at, target } = setup()
    const card = createElement(doc, {
      ...nodeElement(textCard),
      params: { text: '少女，短发' },
      ...at(0, 0),
    })
    const ref = createElement(doc, { kind: 'image', assetId: 'face', ...at(-300, 300) })
    const role = createElement(doc, { ...nodeElement(character), ...at(0, 300) })
    connect(doc, [ref, 'image'], [role, 'references'])
    connect(doc, [card, 'text'], [target, 'prompt'])
    connect(doc, [role, 'image'], [target, 'references'])
    const got = upstreams(engine, target, catalogOf())
    expect(got.get('prompt')![0]!.value).toEqual({ type: 'text', text: '少女，短发' })
    expect(got.get('references')![0]!.value).toEqual({ type: 'image', assetId: 'face' })
    // 没有 catalog 认不出纯节点，按没结果处理
    expect(upstreams(engine, target, null).get('prompt')![0]!.value).toBeUndefined()
  })
})

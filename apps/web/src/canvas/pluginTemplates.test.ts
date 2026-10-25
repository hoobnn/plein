import { type Engine } from '@plein/canvas-core'
import { createElement, type PleinDoc } from '@plein/doc'
import { findMentions, mentionName } from '@plein/nodes'
import { openDoc } from '@plein/doc/testing'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it, vi } from 'vite-plus/test'
import { placeTemplate } from './groups'
import { pluginTemplateData, type PluginTemplate } from './pluginTemplates'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
const node = {
  type: 'acme/text',
  version: 1,
  title: '文字',
  plugin: 'acme/tools',
  category: 'text',
  execution: 'inline',
  executable: false,
  defaults: { text: '默认文字' },
  paramsSchema: {},
  inputs: [{ id: 'in', type: 'text', label: '输入' }],
  outputs: [{ id: 'out', type: 'text', label: '输出' }],
} as const
const template: PluginTemplate = {
  id: 'acme/pair',
  plugin: 'acme/tools',
  title: '文字链',
  nodes: [
    {
      key: 'a',
      type: 'acme/text',
      version: 1,
      title: '第一步',
      x: -100,
      y: 80,
      params: { text: '自定义' },
    },
    { key: 'b', type: 'acme/text', version: 1, x: 300, y: 80 },
  ],
  edges: [{ from: ['a', 'out'], to: ['b', 'in'] }],
}
function catalog(): Catalog {
  return structuredClone({
    nodes: [node, { ...node, version: 2, defaults: { text: '新版默认' } }],
    plugins: [{ id: 'acme/tools', status: 'active' }],
    templates: [template],
    prompts: [],
    providers: [],
    elements: [],
    defaultModels: {},
  }) as unknown as Catalog
}

it('保留精确节点版本、参数、名称和相对位置，模板数据不带运行结果', () => {
  const data = pluginTemplateData(catalog(), template)
  expect(data.elements).toHaveLength(3)
  const [frame, first, second] = data.elements
  expect(frame).toMatchObject({ kind: 'frame', name: '文字链', x: 0, y: 0 })
  expect(first).toMatchObject({
    nodeVersion: 1,
    name: '第一步',
    x: 32,
    y: 32,
    params: { text: '自定义' },
  })
  expect(second).toMatchObject({ nodeVersion: 1, x: 432, y: 32, params: { text: '默认文字' } })
  expect(data.edges).toEqual([
    expect.objectContaining({ from: [first!.id, 'out'], to: [second!.id, 'in'] }),
  ])
  expect(data.elements.every((el) => !el.run && !el.results)).toBe(true)
})

it('整组只占一次撤销，重复插入重映射身份并保留原有内容', () => {
  const doc = openDoc()
  docs.push(doc)
  const original = createElement(doc, {
    kind: 'markdown',
    text: '已有内容',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  doc.undo.clear()
  const engine = { doc, selection: { set: vi.fn() }, setTool: vi.fn() } as unknown as Engine
  const data = pluginTemplateData(catalog(), template)
  doc.undo.stopCapturing()
  const first = placeTemplate(engine, data, { x: 100, y: 200 })
  doc.undo.stopCapturing()
  const second = placeTemplate(engine, data, { x: 1000, y: 200 })
  doc.undo.stopCapturing()
  expect(first).not.toEqual(second)
  expect([...doc.elements()]).toHaveLength(7)
  expect([...doc.edges()]).toHaveLength(2)
  doc.undo.undo()
  expect([...doc.elements()]).toHaveLength(4)
  expect([...doc.edges()]).toHaveLength(1)
  expect(doc.get(original)?.text).toBe('已有内容')
  doc.undo.undo()
  expect([...doc.elements()]).toHaveLength(1)
  expect([...doc.edges()]).toHaveLength(0)
  doc.undo.redo()
  expect([...doc.elements()]).toHaveLength(4)
})

it.each([
  [
    '缺少精确版本',
    (t: PluginTemplate) => {
      t.nodes[0]!.version = 3
    },
    '未安装',
  ],
  [
    '重复节点 key',
    (t: PluginTemplate) => {
      t.nodes[1]!.key = 'a'
    },
    '重复',
  ],
  [
    '无效位置',
    (t: PluginTemplate) => {
      t.nodes[0]!.x = Infinity
    },
    '位置不合法',
  ],
  [
    '缺少端口',
    (t: PluginTemplate) => {
      t.edges[0]!.from[1] = 'missing'
    },
    '端口',
  ],
  [
    '缺少节点',
    (t: PluginTemplate) => {
      t.edges[0]!.from[0] = 'missing'
    },
    '不存在的节点',
  ],
  [
    '重复连线',
    (t: PluginTemplate) => {
      t.edges.push(structuredClone(t.edges[0]!))
    },
    '单输入',
  ],
  [
    '自连',
    (t: PluginTemplate) => {
      t.edges[0]!.to[0] = 'a'
    },
    '端口',
  ],
  [
    '循环',
    (t: PluginTemplate) => {
      t.edges.push({ from: ['b', 'out'], to: ['a', 'in'] })
    },
    '循环',
  ],
] as const)('%s 时拒绝展开', (_name, mutate, message) => {
  const value = structuredClone(template)
  mutate(value)
  expect(() => pluginTemplateData(catalog(), value)).toThrow(message)
})

it('端口类型不匹配和缺少执行器时拒绝，插件卸载后也不能继续插入', () => {
  const value = catalog()
  value.nodes[0]!.outputs[0]!.type = 'image'
  expect(() => pluginTemplateData(value, template)).toThrow('类型不匹配')
  value.nodes[0]!.execution = 'job'
  expect(() => pluginTemplateData(value, template)).toThrow('缺少执行器')
  value.plugins = []
  expect(() => pluginTemplateData(value, template)).toThrow('未加载')
})

it('模板内资产名称引用在目标画布已有同名元素时仍指向新插入节点', () => {
  const doc = openDoc()
  docs.push(doc)
  const outside = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '第一步',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const value = structuredClone(template)
  const registry = catalog()
  registry.nodes[0]!.type = 'plein/character'
  value.nodes.forEach((item) => {
    item.type = 'plein/character'
  })
  value.nodes[1]!.params = { text: '@第一步 保留这份内容' }
  const engine = { doc, selection: { set: vi.fn() }, setTool: vi.fn() } as unknown as Engine
  placeTemplate(engine, pluginTemplateData(registry, value, doc), { x: 200, y: 300 })
  const copied = [...doc.elements()].find((el) => el.name === '第一步' && el.id !== outside)!
  const consumer = [...doc.elements()].find((el) => el.name === '文字')!
  const targets = [...doc.elements()].flatMap((el) => {
    const name = mentionName(el)
    return name ? [{ id: el.id, name }] : []
  })
  expect(findMentions(String(consumer.params?.text), targets)[0]?.id).toBe(copied.id)
  expect(doc.get(outside)?.params).toEqual({})
  expect(doc.worldRect(copied.id)).toMatchObject({ x: 232, y: 332 })
})

it('多输入边按模板声明顺序保留，不按节点坐标排序', () => {
  const value = catalog()
  value.nodes[0]!.inputs[0]!.multiple = true
  const definition = structuredClone(template)
  definition.nodes.push({ ...definition.nodes[0]!, key: 'c', title: '第三步', x: -500 })
  definition.edges.unshift({ from: ['c', 'out'], to: ['b', 'in'] })
  const data = pluginTemplateData(value, definition)
  const names = new Map(data.elements.map((el) => [el.id, el.name]))
  expect(data.edges.map((edge) => names.get(edge.from[0]))).toEqual(['第三步', '第一步'])
  expect(data.edges[0]!.order! < data.edges[1]!.order!).toBe(true)
})

it.each([
  ['林夏', '林夏姐姐', '@林夏姐姐 正在说话', true],
  ['林夏姐姐', '林夏', '@林夏姐姐 正在说话', false],
  ['林夏', '林夏姐姐', '@林夏 正在说话', false],
] as const)(
  '内部名称 %s / 外部名称 %s 按完整引用范围判定，不能只匹配同一起点',
  (insideName, outsideName, text, blocked) => {
    const doc = openDoc()
    docs.push(doc)
    const outside = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/character',
      name: outsideName,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    doc.undo.clear()
    const definition = structuredClone(template)
    const registry = catalog()
    registry.nodes[0]!.type = 'plein/character'
    definition.nodes.forEach((item) => {
      item.type = 'plein/character'
    })
    definition.nodes[0]!.title = insideName
    definition.nodes[1]!.params = { text }
    if (blocked) {
      expect(() => pluginTemplateData(registry, definition, doc)).toThrow('外部资产')
      expect([...doc.elements()]).toHaveLength(1)
      expect(doc.undo.canUndo()).toBe(false)
      return
    }
    const engine = { doc, selection: { set: vi.fn() }, setTool: vi.fn() } as unknown as Engine
    placeTemplate(engine, pluginTemplateData(registry, definition, doc), { x: 200, y: 300 })
    const own = [...doc.elements()].find((el) => el.name === insideName && el.id !== outside)!
    const consumer = [...doc.elements()].find((el) => el.name === '文字')!
    const targets = [...doc.elements()].flatMap((el) => {
      const name = mentionName(el)
      return name ? [{ id: el.id, name }] : []
    })
    expect(findMentions(String(consumer.params?.text), targets)[0]?.id).toBe(own.id)
    expect(doc.get(outside)?.name).toBe(outsideName)
  },
)

it('模板参数类型错误时预检失败，不进入实际粘贴', () => {
  const value = catalog()
  value.nodes[0]!.paramsSchema = { type: 'object', properties: { text: { type: 'string' } } }
  const definition = structuredClone(template)
  definition.nodes[0]!.params = { text: 123 }
  expect(() => pluginTemplateData(value, definition)).toThrow('模板参数不合法')
})

it('引用不完整时不会悄悄借用目标画布资产，模板内同名引用要求先消歧', () => {
  const doc = openDoc()
  docs.push(doc)
  createElement(doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '外部角色',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
  })
  const definition = structuredClone(template)
  definition.nodes[1]!.params = { text: '@外部角色 站在门边' }
  expect(() => pluginTemplateData(catalog(), definition, doc)).toThrow('外部资产')
  const registry = catalog()
  registry.nodes[0]!.type = 'plein/character'
  definition.nodes.forEach((item) => {
    item.type = 'plein/character'
    item.title = '同名角色'
  })
  definition.nodes[1]!.params = { text: '@同名角色 站在门边' }
  expect(() => pluginTemplateData(registry, definition, doc)).toThrow('引用不明确')
  definition.nodes[1]!.params = { text: '@同名角色#1 站在门边' }
  expect(() => pluginTemplateData(registry, definition, doc)).toThrow('引用不明确')
  definition.nodes[1]!.params = { text: '@同名角色#2 站在门边' }
  expect(() => pluginTemplateData(registry, definition, doc)).toThrow('引用不明确')
  expect([...doc.elements()]).toHaveLength(1)
})

it('只读文档不能粘贴且不留下任何元素', () => {
  const doc = openDoc()
  docs.push(doc)
  doc.readOnly = true
  const engine = { doc, selection: { set: vi.fn() }, setTool: vi.fn() } as unknown as Engine
  expect(() =>
    placeTemplate(engine, pluginTemplateData(catalog(), template), { x: 0, y: 0 }),
  ).toThrow('只读')
  expect([...doc.elements()]).toHaveLength(0)
})

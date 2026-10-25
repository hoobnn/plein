import type { Engine } from '@plein/canvas-core'
import { createElement, setParam, type PleinDoc } from '@plein/doc'
import { openDoc } from '@plein/doc/testing'
import type { Catalog } from '@plein/protocol'
import { afterEach, expect, it } from 'vite-plus/test'
import { applyRecipe, recipeSignature, searchRecipes } from './recipes'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))
function fixture() {
  const doc = openDoc()
  docs.push(doc)
  const params = {
    prompt: '手写草稿',
    model: 'chosen/model',
    aspectRatio: '16:9',
    options: { keep: 1 },
  }
  const id = createElement(doc, {
    kind: 'node',
    nodeType: 'test/image',
    nodeVersion: 1,
    x: 0,
    y: 0,
    w: 320,
    h: 180,
    params,
  })
  const preset = {
    id: 'test/recipe',
    plugin: 'test/core',
    title: '三视图',
    template: '【角色】三视图',
    appliesTo: ['image.generate'],
    params: { aspectRatio: '1:1', model: 'wrong/model', options: {}, undeclared: 1 },
  }
  const node = {
    type: 'test/image',
    version: 1,
    capability: 'image.generate',
    paramsSchema: {
      type: 'object',
      properties: {
        prompt: { widget: 'textarea' },
        model: { widget: 'model' },
        options: { widget: 'modelOptions' },
        aspectRatio: { enum: ['16:9', '1:1'] },
      },
    },
  }
  const catalog = { nodes: [node], prompts: [preset] } as unknown as Catalog
  const engine = { doc } as Engine
  const expected = { params: recipeSignature(doc.get(id)?.params), type: 'test/image', version: 1 }
  doc.undo.clear()
  return { doc, engine, id, preset, catalog, expected }
}

it('套用只改草稿和已声明的非模型参数，尺寸及参数一次撤销重做', () => {
  const f = fixture()
  expect(applyRecipe(f.engine, f.catalog, f.id, f.preset, f.expected)).toBeNull()
  expect(f.doc.get(f.id)?.params).toEqual({
    prompt: '【角色】三视图',
    model: 'chosen/model',
    aspectRatio: '1:1',
    options: { keep: 1 },
  })
  expect(f.doc.get(f.id)?.w).toBe(f.doc.get(f.id)?.h)
  expect(f.doc.get(f.id)?.run).toBeUndefined()
  f.doc.undo.undo()
  expect(f.doc.get(f.id)?.params?.prompt).toBe('手写草稿')
  expect(f.doc.get(f.id)?.w).toBe(320)
  expect(f.doc.get(f.id)?.h).toBe(180)
  f.doc.undo.redo()
  expect(f.doc.get(f.id)?.params?.prompt).toBe('【角色】三视图')
})

it('弹窗期间草稿或模型变化时拒绝覆盖', () => {
  const f = fixture()
  setParam(f.doc, f.id, 'model', 'new/model')
  expect(applyRecipe(f.engine, f.catalog, f.id, f.preset, f.expected)).toContain('已变化')
  expect(f.doc.get(f.id)?.params?.prompt).toBe('手写草稿')
  expect(f.doc.get(f.id)?.params?.model).toBe('new/model')
})

it('已卸载预设、参数变化的预设和只读文档均不写入', () => {
  const f = fixture()
  expect(
    applyRecipe(f.engine, { ...f.catalog, prompts: [] }, f.id, f.preset, f.expected),
  ).toContain('目录已变化')
  expect(
    applyRecipe(
      f.engine,
      { ...f.catalog, prompts: [{ ...f.preset, template: 'updated' }] },
      f.id,
      f.preset,
      f.expected,
    ),
  ).toContain('目录已变化')
  f.doc.readOnly = true
  expect(applyRecipe(f.engine, f.catalog, f.id, f.preset, f.expected)).toContain('只读')
  expect(f.doc.get(f.id)?.params?.prompt).toBe('手写草稿')
})

it('按节点能力过滤并搜索用途，镜头风格条不混入完整配方', () => {
  const f = fixture()
  expect(searchRecipes(f.catalog.prompts, f.catalog.nodes[0]!, '三视')).toHaveLength(1)
  expect(
    searchRecipes(f.catalog.prompts, { ...f.catalog.nodes[0]!, capability: 'video.generate' }, ''),
  ).toEqual([])
  expect(searchRecipes([{ ...f.preset, slot: 'style' }], f.catalog.nodes[0]!, '')).toEqual([])
})

it('第三方预设的非法参数不写入文档', () => {
  const f = fixture()
  f.preset.params.aspectRatio = 'invalid'
  expect(applyRecipe(f.engine, f.catalog, f.id, f.preset, f.expected)).toContain('参数无效')
  expect(f.doc.get(f.id)?.params?.prompt).toBe('手写草稿')
  expect(f.doc.undo.canUndo()).toBe(false)
})

it('当前模型不支持推荐画幅时拒绝套用，不静默换模型或校正推荐', () => {
  const f = fixture()
  setParam(f.doc, f.id, 'model', 'chosen:model')
  f.expected.params = recipeSignature(f.doc.get(f.id)?.params)
  f.catalog.providers = [
    {
      id: 'chosen',
      enabled: true,
      configured: true,
      models: [
        {
          id: 'model',
          title: '保留模型',
          capabilities: ['image.generate'],
          limits: { aspectRatios: ['16:9'] },
        },
      ],
    },
  ] as Catalog['providers']
  expect(applyRecipe(f.engine, f.catalog, f.id, f.preset, f.expected)).toContain('不适用于当前模型')
  expect(f.doc.get(f.id)?.params).toMatchObject({
    prompt: '手写草稿',
    model: 'chosen:model',
    aspectRatio: '16:9',
  })
})

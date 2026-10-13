import type { Engine } from '@plein/canvas-core'
import { addResults, createDoc, createElement } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { applyCast, castOf } from './cast'

const card = (type: string, title: string) =>
  ({
    type,
    version: 1,
    title,
    executable: false,
    defaults: { description: '' },
    paramsSchema: { properties: {} },
    inputs: [],
    outputs: [],
  }) as unknown as Catalog['nodes'][number]

const catalog = {
  nodes: [card('plein/character', '角色'), card('plein/scene', '场景'), card('plein/prop', '道具')],
} as unknown as Catalog

const CAST = `## 角色
### 林晚
- 外貌与年龄：二十岁，短发
### 老周
- 外貌与年龄：五十多岁

## 场景
### 天台
- 时间与地点：雨夜`

const setup = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const llm = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/llm',
    name: '角色与场景抽取',
    x: 0,
    y: 0,
    w: 280,
    h: 240,
  })
  addResults(doc, llm, [
    { id: 'r1', port: 'text', value: { type: 'text', text: CAST }, runId: 'run1', at: 1 },
  ])
  const engine = { doc } as unknown as Engine
  const asset = (nodeType: string, name: string, description: string) =>
    createElement(doc, {
      kind: 'node',
      nodeType,
      name,
      params: { description },
      x: 0,
      y: 400,
      w: 200,
      h: 100,
    })
  return { doc, engine, llm, asset }
}

describe('抽取结果落成设定卡', () => {
  it('新名字建卡，按类型分列放在来源右侧', () => {
    const { doc, engine, llm } = setup()
    const r = applyCast(engine, catalog, llm, castOf(engine, llm))
    expect(r.created).toHaveLength(3)
    const made = r.created.map((id) => doc.get(id)!)
    expect(made.map((e) => [e.nodeType, e.name, e.params?.description])).toEqual([
      ['plein/character', '林晚', '外貌与年龄：二十岁，短发'],
      ['plein/character', '老周', '外貌与年龄：五十多岁'],
      ['plein/scene', '天台', '时间与地点：雨夜'],
    ])
    // 不压在来源节点上；同类竖排、不同类分列
    for (const e of made) expect(e.x).toBeGreaterThan(280)
    expect(made[0]!.x).toBe(made[1]!.x)
    expect(made[1]!.y).toBeGreaterThan(made[0]!.y)
    expect(made[2]!.x).toBeGreaterThan(made[0]!.x)
  })

  it('同名卡：空设定补上，写过的不覆盖；重名或类型不同的不动', () => {
    const { doc, engine, llm, asset } = setup()
    const empty = asset('plein/character', '林晚', '')
    const written = asset('plein/character', '老周', '我自己写的')
    asset('plein/prop', '天台', '其实是个道具')
    const r = applyCast(engine, catalog, llm, castOf(engine, llm))
    expect(r).toEqual({ created: [], filled: ['林晚'], kept: ['老周'], ambiguous: ['天台'] })
    expect(doc.get(empty)?.params?.description).toBe('外貌与年龄：二十岁，短发')
    expect(doc.get(written)?.params?.description).toBe('我自己写的')
  })

  it('再点一次不会重复建卡', () => {
    const { engine, llm } = setup()
    applyCast(engine, catalog, llm, castOf(engine, llm))
    const again = applyCast(engine, catalog, llm, castOf(engine, llm))
    expect(again.created).toEqual([])
    expect(again.kept).toEqual(['林晚', '老周', '天台'])
  })
})

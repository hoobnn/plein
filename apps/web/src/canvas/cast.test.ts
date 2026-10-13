import type { Engine } from '@plein/canvas-core'
import { addResults, createDoc, createElement } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { applyCast, castOf, describeCast } from './cast'

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
    expect(r).toEqual({
      created: [],
      portraits: [],
      fromLibrary: [],
      voiced: [],
      filled: ['林晚'],
      kept: ['老周'],
      ambiguous: ['天台'],
      libraryAmbiguous: [],
    })
    expect(doc.get(empty)?.params?.description).toBe('外貌与年龄：二十岁，短发')
    expect(doc.get(written)?.params?.description).toBe('我自己写的')
  })

  it('每张新角色卡配一个定妆图节点连进参考图；角色按性别、年龄配上配音模型的音色', () => {
    const { doc, engine, llm } = setup()
    addResults(doc, llm, [
      {
        id: 'r2',
        port: 'text',
        value: {
          type: 'text',
          text: `## 角色
### 林晚
- 性别：女
- 外貌与年龄：二十岁，短发
### 黑衣男
- 外貌与年龄：三十岁，黑色雨衣
### 老周
- 性别：男
- 外貌与年龄：五十多岁，快递站老板
### 阿九
- 外貌与年龄：看不出年纪

## 场景
### 天台
- 时间与地点：雨夜`,
        },
        runId: 'run2',
        at: 2,
      },
    ])
    const image = {
      ...card('plein/image', '生成图片'),
      defaults: { prompt: '', aspectRatio: '16:9', count: 2 },
      outputs: [{ id: 'images', label: '图片', type: 'image' }],
    }
    const voices = [
      { id: 'f1', title: '女一', gender: 'female' },
      { id: 'm1', title: '男一', gender: 'male' },
      { id: 'm2', title: '男二', gender: 'male' },
      { id: 'm9', title: '大叔', gender: 'male', age: 'mature' },
    ]
    const full = {
      nodes: [
        ...catalog.nodes.map((n) => ({
          ...n,
          inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
        })),
        image,
      ],
      providers: [
        {
          id: 'doubao/speech',
          enabled: true,
          models: [{ id: 'tts', title: 'TTS', capabilities: ['audio.speech'], voices }],
        },
      ],
    } as unknown as Catalog
    const r = applyCast(engine, full, llm, castOf(engine, llm))
    // 只给角色配：场景卡不会被镜头 @ 到
    expect(r.portraits).toHaveLength(4)
    const edges = [...doc.edges()].map((e) => `${e.from.join('.')}→${e.to.join('.')}`)
    for (const [i, id] of r.created.slice(0, 4).entries())
      expect(edges).toContain(`${r.portraits[i]}.images→${id}.references`)
    const lin = doc.get(r.portraits[0]!)!
    expect(lin.name).toBe('林晚 · 定妆图')
    expect(lin.params?.prompt).toContain('三视图')
    expect(lin.params?.prompt).toContain('二十岁，短发')
    expect(lin.params?.count).toBe(1)
    // 定妆图在卡片左边，不压住卡片
    const linCard = doc.get(r.created[0]!)!
    expect(lin.x + lin.w).toBeLessThan(linCard.x)

    const voiceOf = (name: string) =>
      r.created.map((id) => doc.get(id)!).find((e) => e.name === name)?.params?.voice
    expect(voiceOf('林晚')).toEqual({ provider: 'doubao/speech', voiceId: 'f1' })
    expect(voiceOf('黑衣男')).toEqual({ provider: 'doubao/speech', voiceId: 'm1' })
    expect(voiceOf('老周')).toEqual({ provider: 'doubao/speech', voiceId: 'm9' })
    // 看不出性别的不乱配
    expect(voiceOf('阿九')).toBeUndefined()
    expect(r.voiced).toEqual(['林晚', '黑衣男', '老周'])
  })

  it('资产库里有同名角色：照条目建卡，带上参考图和音色，不配定妆图；本项目优先，指不明的不套用', () => {
    const { doc, engine, llm } = setup()
    const image = {
      ...card('plein/image', '生成图片'),
      defaults: { prompt: '', aspectRatio: '16:9', count: 2 },
      outputs: [{ id: 'images', label: '图片', type: 'image' }],
    }
    const full = {
      nodes: [
        ...catalog.nodes.map((n) => ({
          ...n,
          inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
        })),
        image,
      ],
    } as unknown as Catalog
    const item = (id: string, name: string, projectId: string | null, kind = 'character') => ({
      id,
      kind,
      name,
      description: `${name}：资产库里的设定`,
      voice: { provider: 'doubao/speech', voiceId: `voice-${id}` },
      images: [{ slot: 'main', assetId: `asset-${id}` }],
      projectId,
    })
    const r = applyCast(engine, full, llm, castOf(engine, llm), {
      // 林晚：别的项目和本项目各一条，用本项目的；老周：别的项目两条，指不明
      items: [
        item('lw-other', '林晚', 'pj_other'),
        item('lw-here', '林晚', 'pj_here'),
        item('lz-1', '老周', 'pj_a'),
        item('lz-2', '老周', 'pj_b'),
      ],
      projectId: 'pj_here',
    })
    expect(r.fromLibrary).toEqual(['林晚'])
    expect(r.libraryAmbiguous).toEqual(['老周'])
    const lin = doc.get(r.created[0]!)!
    expect(lin.params).toMatchObject({
      description: '林晚：资产库里的设定',
      voice: { provider: 'doubao/speech', voiceId: 'voice-lw-here' },
      libraryId: 'lw-here',
    })
    const into = [...doc.edges()].filter((e) => e.to[0] === lin.id)
    expect(into.map((e) => doc.get(e.from[0])?.assetId)).toEqual(['asset-lw-here'])
    // 只有老周配了定妆图；参考图不压在卡片上
    expect(r.portraits.map((id) => doc.get(id)?.name)).toEqual(['老周 · 定妆图'])
    const ref = doc.get(into[0]!.from[0])!
    expect(ref.x + ref.w).toBeLessThan(lin.x)
    expect(describeCast(r)).toContain('林晚 用了资产库里的设定和参考图')
    expect(describeCast(r)).toContain('资产库里有多个「老周」')
  })

  it('再点一次不会重复建卡', () => {
    const { engine, llm } = setup()
    applyCast(engine, catalog, llm, castOf(engine, llm))
    const again = applyCast(engine, catalog, llm, castOf(engine, llm))
    expect(again.created).toEqual([])
    expect(again.kept).toEqual(['林晚', '老周', '天台'])
  })
})

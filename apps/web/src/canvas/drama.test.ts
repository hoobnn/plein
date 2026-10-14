import type { Engine } from '@plein/canvas-core'
import { createDoc } from '@plein/doc'
import { corePlugin } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vite-plus/test'
import { dramaNotice, placeDramaTemplate } from './drama'

/** 用真实的内置节点声明拼一个最小 catalog：端口和默认参数与线上一样 */
const nodes = corePlugin.nodes.map((n) => ({ ...describeNode(n, 'plein/core'), executable: true }))
const catalog = {
  nodes,
  providers: [
    {
      id: 'ark',
      enabled: true,
      configured: true,
      models: [
        { id: 'seed', title: 'Doubao Seed', capabilities: ['text.chat'] },
        { id: 'seedream', title: 'Seedream', capabilities: ['image.generate'] },
        { id: 'seedance', title: 'Seedance', capabilities: ['video.generate'] },
      ],
    },
  ],
  defaultModels: {
    'text.chat': 'ark:seed',
    'image.generate': 'ark:seedream',
    'video.generate': 'ark:seedance',
  },
} as unknown as Catalog

const emptyCatalog = { nodes, providers: [], defaultModels: {} } as unknown as Catalog

const setup = () => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const engine = {
    doc,
    selection: { set: () => {} },
    setTool: () => {},
  } as unknown as Engine
  return { doc, engine }
}

const kind = (doc: ReturnType<typeof setup>['doc'], nodeType: string) =>
  [...doc.elements()].filter((el) => el.kind === 'node' && el.nodeType === nodeType)

describe('短剧模板落到画布', () => {
  it('铺出完整骨架与连线，落在指定坐标', () => {
    const { doc, engine } = setup()
    const r = placeDramaTemplate(engine, catalog, { x: 1000, y: 200 })
    expect(r.missing).toEqual([])
    expect(r.loose).toBe(0)
    expect(r.frames).toHaveLength(2)

    const frames = [...doc.elements()].filter((el) => el.kind === 'frame')
    expect(frames).toHaveLength(3) // 两个顶层分组 + 样例车道
    // 顶层分组的左上角就是落点
    expect(doc.worldRect(r.frames[0]!)).toMatchObject({ x: 1000, y: 200 })
    // 第二个分组在第一个下方
    const [a, b] = r.frames.map((id) => doc.worldRect(id)!)
    expect(b!.y).toBeGreaterThan(a!.y + a!.h)

    // 关键节点都在
    for (const type of [
      'plein/llm',
      'plein/storyboard',
      'plein/image',
      'plein/video',
      'plein/speech',
      'plein/music',
      'plein/character',
      'plein/scene',
      'plein/sequence',
    ]) {
      expect(kind(doc, type).length, type).toBeGreaterThan(0)
    }
    expect([...doc.elements()].filter((el) => el.kind === 'markdown')).toHaveLength(1)
  })

  it('图生视频的连线、分镜与序列的连线都在', () => {
    const { doc, engine } = setup()
    placeDramaTemplate(engine, catalog, { x: 0, y: 0 })
    const edges = [...doc.edges()].map(
      (e) => `${e.from[1]}@${doc.get(e.from[0])?.nodeType ?? 'md'}→${e.to[1]}`,
    )
    // 分镜图输出 images → 视频首帧
    expect(
      [...doc.edges()].some((e) => {
        const from = doc.get(e.from[0])
        const to = doc.get(e.to[0])
        return (
          e.from[1] === 'images' &&
          e.to[1] === 'images' &&
          from?.nodeType === 'plein/image' &&
          to?.nodeType === 'plein/video'
        )
      }),
    ).toBe(true)
    // 样例车道不接序列，真实镜头由分镜展开时接入
    expect(edges).not.toContain('video@plein/video→clips')
    expect(edges).not.toContain('audio@plein/speech→dialogue')
    expect(edges).toContain('audio@plein/music→music')
    expect(edges).toContain('text@plein/llm→script')
    expect(edges).toContain('text@md→prompt')
  })

  it('插入只建结构，不触发任何运行', () => {
    const { doc, engine } = setup()
    placeDramaTemplate(engine, catalog, { x: 0, y: 0 })
    // 没有一个节点带运行状态，也没有任何生成结果
    for (const el of doc.elements()) {
      expect(el.run, el.id).toBeUndefined()
      expect(el.results, el.id).toBeUndefined()
    }
  })

  it('模型用设置里的默认模型：没有默认模型的能力留空并提示', () => {
    const { doc, engine } = setup()
    const r = placeDramaTemplate(engine, catalog, { x: 0, y: 0 })
    expect(r.noModel).toEqual(['配音', '配乐'])
    for (const el of kind(doc, 'plein/llm')) expect(el.params?.model).toBe('ark:seed')
    for (const el of kind(doc, 'plein/image')) expect(el.params?.model).toBe('ark:seedream')
    for (const el of kind(doc, 'plein/video')) expect(el.params?.model).toBe('ark:seedance')
    // 没有默认模型的能力留空，等用户去设置里启用平台
    for (const el of [...kind(doc, 'plein/speech'), ...kind(doc, 'plein/music')])
      expect(el.params?.model).toBe('')
    expect(dramaNotice(r)).toContain('请到设置里启用')

    const { doc: doc2, engine: engine2 } = setup()
    const bare = placeDramaTemplate(engine2, emptyCatalog, { x: 0, y: 0 })
    expect(bare.noModel).toEqual(['文本', '图像', '视频', '配音', '配乐'])
    for (const type of ['plein/llm', 'plein/image', 'plein/video', 'plein/speech', 'plein/music'])
      for (const el of kind(doc2, type)) expect(el.params?.model).toBe('')
  })

  it('catalog 里没有的可选卡片只跳过，不算骨架缺失', () => {
    const { doc, engine } = setup()
    const r = placeDramaTemplate(engine, catalog, { x: 0, y: 0 })
    expect(r.missing).toEqual([])
    for (const type of r.optionalMissing) expect(type.startsWith('plein/')).toBe(true)
    // 分镜节点本身在，展开镜头不受影响
    const board = kind(doc, 'plein/storyboard')[0]!
    expect(board.params?.shotCount).toBe(8)
    expect(board.params?.shots).toEqual([])
  })
})

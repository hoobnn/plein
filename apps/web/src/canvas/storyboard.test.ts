import type { Engine } from '@plein/canvas-core'
import { createDoc, createElement, setParam, setParams, writeRun } from '@plein/doc'
import { dropShot, planVersion, type Shot } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { describe, expect, it } from 'vitest'
import {
  detachShot,
  expandShots,
  expandedNodes,
  planDiffs,
  runExpanded,
  shotsOf,
  syncExpanded,
} from './storyboard'

/** 最小 catalog：只需要展开用到的三个节点声明 */
const info = (
  type: string,
  title: string,
  inputs: { id: string; label: string; type: string; multiple?: boolean }[],
  outputs: { id: string; label: string; type: string }[],
) =>
  ({
    type,
    version: 1,
    title,
    capability: 'x.generate',
    executable: true,
    defaults: {},
    paramsSchema: { properties: {} },
    inputs,
    outputs,
  }) as unknown as Catalog['nodes'][number]

const catalog = {
  nodes: [
    info(
      'plein/image',
      '生成图片',
      [
        { id: 'prompt', label: '提示词', type: 'text', multiple: true },
        { id: 'references', label: '参考图', type: 'image', multiple: true },
      ],
      [{ id: 'images', label: '图片', type: 'image' }],
    ),
    info(
      'plein/video',
      '生成视频',
      [
        { id: 'prompt', label: '提示词', type: 'text', multiple: true },
        { id: 'images', label: '图片', type: 'image', multiple: true },
      ],
      [
        { id: 'video', label: '视频', type: 'video' },
        { id: 'lastFrame', label: '尾帧', type: 'image' },
      ],
    ),
    info(
      'plein/speech',
      '配音',
      [{ id: 'text', label: '台词', type: 'text', multiple: true }],
      [{ id: 'audio', label: '语音', type: 'audio' }],
    ),
  ],
} as unknown as Catalog

const shot = (no: number, extra: Partial<Shot> = {}): Shot => ({
  id: `s${no}`,
  no,
  duration: 5,
  shotSize: '中景',
  description: `画面 ${no}`,
  characters: [],
  emotion: '',
  lighting: '',
  sfx: '',
  dialogue: [],
  imagePrompt: '',
  motionPrompt: '',
  ...extra,
})

const setup = (shots: Shot[]) => {
  const doc = createDoc(undefined, { schedule: () => {} })
  const board = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/storyboard',
    name: '分镜',
    params: { shots },
    x: 0,
    y: 0,
    w: 400,
    h: 300,
  })
  // 角色卡：出场角色同名时分镜图提示词里 @ 它，配音节点取它的音色
  const card = createElement(doc, {
    kind: 'node',
    nodeType: 'plein/character',
    name: '林夏',
    params: { description: '短发', voice: { provider: 'doubao-speech', voiceId: 'v_linxia' } },
    x: 0,
    y: 400,
    w: 200,
    h: 100,
  })
  const engine = { doc } as unknown as Engine
  const table = (next: Shot[]) => setParam(doc, board, 'shots', next)
  return { doc, engine, board, card, table }
}

const nodesOf = (engine: Engine, board: string, shotId: string) =>
  expandedNodes(engine, board).get(shotId) ?? []
/** 展开时写在节点上的来源信息 */
const srcOf = (el: { params?: Record<string, unknown> }) =>
  el.params?.source as
    | {
        role: string
        line?: number
        detached?: boolean
        plan?: { version: string; params: Record<string, unknown> }
      }
    | undefined
const roleOf = (el: { params?: Record<string, unknown> }) => srcOf(el)!.role

describe('展开时记下计划版本', () => {
  it('每个新节点都带上展开快照，快照里的值就是节点参数', () => {
    const s = shot(1, {
      characters: ['林夏'],
      imagePrompt: '低机位仰拍',
      motionPrompt: '缓慢推近',
      duration: 7,
      dialogue: [
        { character: '林夏', line: '你终于来了' },
        { character: '路人', line: '别过去' },
      ],
    })
    const { engine, board } = setup([s])
    const result = expandShots(engine, board, [s.id], catalog)
    expect(result.created).toBe(4)
    expect(result.frames).toHaveLength(1)

    const version = planVersion([s])
    const nodes = nodesOf(engine, board, s.id)
    expect(nodes.map(roleOf).sort()).toEqual(['image', 'speech', 'speech', 'video'])
    for (const el of nodes) {
      const plan = srcOf(el)!.plan!
      expect(plan.version).toBe(version)
      for (const [k, v] of Object.entries(plan.params)) expect(el.params?.[k]).toEqual(v)
    }
    const image = nodes.find((el) => roleOf(el) === 'image')!
    expect(image.params?.prompt).toBe('@林夏 低机位仰拍')
    const video = nodes.find((el) => roleOf(el) === 'video')!
    expect(video.params).toMatchObject({ prompt: '缓慢推近', duration: 7 })
    const speech = nodes.filter((el) => roleOf(el) === 'speech')
    expect(speech.map((el) => el.params?.text).sort()).toEqual(['你终于来了', '别过去'])
    // 音色连平台一起写进配音节点：换成别家模型时服务端能判定不兼容
    expect(speech.find((el) => el.params?.text === '你终于来了')?.params?.voice).toEqual({
      provider: 'doubao-speech',
      voiceId: 'v_linxia',
    })
    expect(speech.find((el) => el.params?.text === '别过去')?.params?.voice).toEqual({
      provider: '',
      voiceId: '',
    })
  })

  it('分镜图 → 视频的连线在展开时建立', () => {
    const { doc, engine, board } = setup([shot(1)])
    expandShots(engine, board, ['s1'], catalog)
    const nodes = nodesOf(engine, board, 's1')
    const image = nodes.find((el) => roleOf(el) === 'image')!
    const video = nodes.find((el) => roleOf(el) === 'video')!
    expect([...doc.edges()].some((e) => e.from[0] === image.id && e.to[0] === video.id)).toBe(true)
  })
})

describe('重新展开', () => {
  it('默认只展开没展开过的镜头', () => {
    const { engine, board } = setup([shot(1), shot(2)])
    expect(expandShots(engine, board, ['s1', 's2'], catalog).created).toBe(4)
    const again = expandShots(engine, board, ['s1', 's2'], catalog)
    expect(again.created).toBe(0)
    expect(nodesOf(engine, board, 's1')).toHaveLength(2)
  })

  it('更新展开：只补新增的台词，已有节点连手改都不动', () => {
    const s = shot(1, { dialogue: [{ character: '林夏', line: '第一句' }] })
    const { engine, board, table } = setup([s])
    expandShots(engine, board, [s.id], catalog)
    const image = nodesOf(engine, board, s.id).find((el) => roleOf(el) === 'image')!
    setParams(engine.doc, image.id, { prompt: '我自己写的画面' })

    // 表格里加一句台词，再更新展开
    table([
      {
        ...s,
        dialogue: [
          { character: '林夏', line: '第一句' },
          { character: '路人', line: '第二句' },
        ],
      },
    ])
    const result = expandShots(engine, board, [s.id], catalog, { mode: 'update' })
    expect(result.updated).toBe(1)
    expect(result.created).toBe(1)
    const nodes = nodesOf(engine, board, s.id)
    expect(nodes).toHaveLength(4)
    expect(engine.doc.get(image.id)?.params?.prompt).toBe('我自己写的画面')
    // 补出来的配音节点带上了台词和它自己的快照
    const added = nodes.find((el) => el.params?.text === '第二句')!
    expect(srcOf(added)!.plan!.version).toBe(planVersion(shotsOf(engine.doc.get(board))))
    // 补完再更新一次：没有可补的了
    expect(expandShots(engine, board, [s.id], catalog, { mode: 'update' }).created).toBe(0)
  })
})

describe('台词增删后配音节点不错位', () => {
  const start = () => {
    const s = shot(1, {
      dialogue: [
        { character: '林夏', line: '第一句' },
        { character: '路人', line: '第二句' },
        { character: '林夏', line: '第三句' },
      ],
    })
    const { engine, board, table } = setup([s])
    expandShots(engine, board, [s.id], catalog)
    const speech = (text: string) =>
      nodesOf(engine, board, s.id).find((el) => el.params?.text === text)!
    return { engine, board, table, s, speech }
  }

  it('删掉中间一句：其余节点没有差异，同步不会改写台词', () => {
    const { engine, board, table, s, speech } = start()
    const second = speech('第二句')
    table([{ ...s, dialogue: [s.dialogue[0]!, s.dialogue[2]!] }])
    expect(planDiffs(engine, board).get(s.id) ?? []).toEqual([])
    syncExpanded(engine, board, [s.id], 'unmodified')
    expect(engine.doc.get(second.id)?.params?.text).toBe('第二句')
    expect(engine.doc.get(speech('第三句').id)?.params?.text).toBe('第三句')
    // 更新展开也不会给剩下的台词重复建节点
    expect(expandShots(engine, board, [s.id], catalog, { mode: 'update' }).created).toBe(0)
  })

  it('开头插一句：只给新台词补节点，同步后已有节点记下新序号', () => {
    const { engine, board, table, s, speech } = start()
    table([{ ...s, dialogue: [{ character: '路人', line: '开场白' }, ...s.dialogue] }])
    expect(expandShots(engine, board, [s.id], catalog, { mode: 'update' }).created).toBe(1)
    expect(speech('开场白')).toBeDefined()
    syncExpanded(engine, board, [s.id], 'unmodified')
    expect(srcOf(engine.doc.get(speech('第三句').id)!)!.line).toBe(3)
    expect(engine.doc.get(speech('第一句').id)?.params?.text).toBe('第一句')
  })
})

describe('表格改动 → 差异 → 用户选择同步', () => {
  const start = () => {
    const s = shot(1, { imagePrompt: '低机位', motionPrompt: '缓慢推近', duration: 7 })
    const { engine, board, table } = setup([s])
    expandShots(engine, board, [s.id], catalog)
    const nodes = nodesOf(engine, board, s.id)
    return {
      engine,
      board,
      table,
      s,
      image: nodes.find((el) => roleOf(el) === 'image')!,
      video: nodes.find((el) => roleOf(el) === 'video')!,
    }
  }

  it('没改表格时没有差异', () => {
    const { engine, board } = start()
    expect(planDiffs(engine, board).size).toBe(0)
  })

  it('表格改了能看到出入：提示词从计划变成了别的值', () => {
    const { engine, board, table, s } = start()
    table([{ ...s, description: '雨夜天台', motionPrompt: '雨夜天台', duration: 9 }])
    const diffs = planDiffs(engine, board).get(s.id) ?? []
    const video = diffs.find((d) => d.role === 'video')!
    const prompt = video.diffs.find((f) => f.key === 'prompt')!
    expect([prompt.expanded, prompt.wanted]).toEqual(['缓慢推近', '雨夜天台'])
    expect(prompt.stale).toBe(true)
    expect(video.diffs.map((f) => f.key).sort()).toEqual(['duration', 'prompt'])
  })

  it('同步未改字段：手改过的提示词留着，时长按计划更新；分镜表不被回写', () => {
    const { engine, board, table, s, image, video } = start()
    setParams(engine.doc, image.id, { prompt: '我自己写的画面' })
    table([
      {
        ...s,
        imagePrompt: '低机位',
        description: '雨夜天台',
        motionPrompt: '雨夜天台',
        duration: 9,
      },
    ])

    const result = syncExpanded(engine, board, [s.id], 'unmodified')
    expect(result.fields).toBe(2)
    expect(result.kept).toBe(1)
    expect(engine.doc.get(image.id)?.params?.prompt).toBe('我自己写的画面')
    expect(engine.doc.get(video.id)?.params?.duration).toBe(9)
    expect(engine.doc.get(video.id)?.params?.prompt).toBe('雨夜天台')
    // 只写计划管的参数，节点自己的模型等保持不动
    expect(engine.doc.get(video.id)?.params?.model).toBeUndefined()
    // 下游不回写分镜表
    expect(shotsOf(engine.doc.get(board))).toEqual([
      {
        ...s,
        imagePrompt: '低机位',
        description: '雨夜天台',
        motionPrompt: '雨夜天台',
        duration: 9,
      },
    ])
    // 同步过这一版就不再提示；分镜再改才重新出现
    expect(planDiffs(engine, board).size).toBe(0)
    table([
      {
        ...s,
        imagePrompt: '高机位',
        description: '霓虹反光',
        motionPrompt: '雨夜天台',
        duration: 9,
      },
    ])
    const again = planDiffs(engine, board).get(s.id) ?? []
    expect(again.flatMap((d) => d.diffs.map((f) => f.key))).toEqual(['prompt'])
    // 剩下的是用户接管的提示词：只提示，不会被再次覆盖
    expect(again[0]!.role).toBe('image')
    expect(again[0]!.diffs[0]!.overridden).toBe(true)
    expect(syncExpanded(engine, board, [s.id], 'unmodified').fields).toBe(0)
    expect(engine.doc.get(image.id)?.params?.prompt).toBe('我自己写的画面')
  })

  it('保留用户覆盖：一个字段都不写，节点现状固化成新基线', () => {
    const { engine, board, table, s, image, video } = start()
    setParams(engine.doc, image.id, { prompt: '我自己写的画面' })
    table([{ ...s, description: '雨夜天台', duration: 9 }])

    const result = syncExpanded(engine, board, [s.id], 'keep-overrides')
    expect(result.fields).toBe(0)
    expect(result.nodes).toBe(0)
    expect(engine.doc.get(video.id)?.params?.duration).toBe(7)
    expect(planDiffs(engine, board).size).toBe(0)
  })

  it('没有快照的老节点（升级前展开的）：差异照样列出来，同步后才写', () => {
    const { engine, board, table, s, image } = start()
    // 升级前的节点没有 source.plan：分不清手改与否，标成旧节点交给用户看
    setParams(engine.doc, image.id, { source: { storyboard: board, shot: 's1', role: 'image' } })
    table([{ ...s, imagePrompt: '俯拍' }])
    const diffs = planDiffs(engine, board).get('s1') ?? []
    expect(diffs).toHaveLength(1)
    expect(diffs[0]!.diffs[0]).toMatchObject({
      key: 'prompt',
      wanted: '俯拍',
      actual: '低机位',
      overridden: false,
      legacy: true,
    })
    expect(syncExpanded(engine, board, ['s1'], 'unmodified').fields).toBe(1)
    expect(engine.doc.get(image.id)?.params?.prompt).toBe('俯拍')
    expect(planDiffs(engine, board).size).toBe(0)
  })
})

describe('删除镜头不抹掉已生成素材', () => {
  it('行删掉后节点和连线都还在，只是脱离计划', () => {
    const s = shot(1, { dialogue: [{ character: '林夏', line: '别跑' }] })
    const { doc, engine, board, table } = setup([s])
    expandShots(engine, board, [s.id], catalog)
    const ids = nodesOf(engine, board, s.id).map((el) => el.id)

    const { shots: left } = dropShot(shotsOf(doc.get(board)), s.id)
    doc.ydoc.transact(() => {
      setParam(doc, board, 'shots', left)
      detachShot(engine, board, s.id)
    })
    doc.flush()

    expect(shotsOf(doc.get(board))).toEqual([])
    for (const id of ids) expect(doc.get(id)).toBeDefined()
    expect(doc.get(ids[0]!)?.parentId).toBeTruthy()
    expect([...doc.edges()]).toHaveLength(1)
    // 脱离计划的节点标上标记，不再出现在差异面板里
    for (const id of ids) expect(srcOf(doc.get(id)!)!.detached).toBe(true)
    expect(planDiffs(engine, board).size).toBe(0)
    // 重新展开同 id 的镜头也不会把老节点当自己的
    table([s])
    expect(expandShots(engine, board, [s.id], catalog).created).toBe(0)
  })
})

describe('批量配音', () => {
  it('跳过没台词、还没展开和正在跑的镜头，并给出计数', () => {
    const spoken = shot(1, { dialogue: [{ character: '林夏', line: '别跑' }] })
    const silent = shot(2)
    const unexpanded = shot(3, { dialogue: [{ character: '林夏', line: '第三句' }] })
    const { engine, board } = setup([spoken, silent, unexpanded])
    expandShots(engine, board, [spoken.id], catalog)
    const speech = nodesOf(engine, board, spoken.id).filter((el) => roleOf(el) === 'speech')
    writeRun(engine.doc, speech[0]!.id, { id: 'r1', status: 'running', at: 0 })

    const started: string[] = []
    const result = runExpanded(
      engine,
      board,
      [spoken.id, silent.id, unexpanded.id],
      'speech',
      (id) => started.push(id),
    )
    expect(started).toEqual([])
    expect(result).toMatchObject({
      started: 0,
      skipped: 3,
      reasons: { 正在运行: 1, 没有台词: 1, 还没展开成节点: 1 },
    })
  })

  it('台词齐全的镜头正常发起', () => {
    const s = shot(1, { dialogue: [{ character: '林夏', line: '别跑' }] })
    const { engine, board } = setup([s])
    expandShots(engine, board, [s.id], catalog)
    const started: string[] = []
    const result = runExpanded(engine, board, [s.id], 'speech', (id) => started.push(id))
    expect(result).toMatchObject({ started: 1, skipped: 0 })
    expect(started).toHaveLength(1)
  })
})

describe('画布上有重名资产卡时不猜', () => {
  it('同名角色卡不写进提示词，并报出是哪些名字指不明', () => {
    const s = shot(1, { characters: ['林夏', '路人'], imagePrompt: '低机位' })
    const { doc, engine, board } = setup([s])
    // 再来一张同名的角色卡：分镜里只写了名字，指不出是哪一张
    createElement(doc, {
      kind: 'node',
      nodeType: 'plein/character',
      name: '林夏',
      params: { description: '长发', voice: { provider: '', voiceId: '' } },
      x: 300,
      y: 400,
      w: 200,
      h: 100,
    })
    const result = expandShots(engine, board, [s.id], catalog)
    expect(result.ambiguous).toEqual(['林夏'])
    const image = nodesOf(engine, board, s.id).find((el) => roleOf(el) === 'image')!
    expect(image.params?.prompt).toBe('低机位')
    expect(image.params?.prompt).not.toContain('@林夏')
  })

  it('名字唯一时照常引用并带上角色卡音色', () => {
    const s = shot(1, { characters: ['林夏'], imagePrompt: '低机位' })
    const { engine, board } = setup([s])
    const result = expandShots(engine, board, [s.id], catalog)
    expect(result.ambiguous).toEqual([])
    const image = nodesOf(engine, board, s.id).find((el) => roleOf(el) === 'image')!
    expect(image.params?.prompt).toBe('@林夏 低机位')
  })
})

describe('展开的镜头接入序列', () => {
  const addSequence = (doc: Engine['doc'], x = 800) =>
    createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      name: '序列',
      params: { clips: [] },
      ports: {
        inputs: [
          { id: 'clips', label: '镜头', type: 'video', multiple: true },
          { id: 'dialogue', label: '对白', type: 'audio', multiple: true },
        ],
        outputs: [{ id: 'video', label: '成片', type: 'video' }],
      },
      x,
      y: 0,
      w: 200,
      h: 300,
    })
  const intoSeq = (doc: Engine['doc'], seq: string) =>
    [...doc.edges()].filter((e) => e.to[0] === seq).map((e) => [e.from[0], e.to[1]])

  it('按表格顺序接视频与首句配音，没台词的镜头明确不配对白', () => {
    const s1 = shot(1)
    const s2 = shot(2, { dialogue: [{ character: '林夏', line: '你来了' }] })
    const { doc, engine, board } = setup([s1, s2])
    const seq = addSequence(doc)
    const result = expandShots(engine, board, [s1.id, s2.id], catalog)
    expect(result.sequence).toBe('linked')
    const role = (shotId: string, r: string) =>
      nodesOf(engine, board, shotId).find((el) => roleOf(el) === r)!.id
    const v1 = role(s1.id, 'video')
    const v2 = role(s2.id, 'video')
    const a2 = role(s2.id, 'speech')
    expect(intoSeq(doc, seq)).toEqual([
      [v1, 'clips'],
      [v2, 'clips'],
      [a2, 'dialogue'],
    ])
    // 不写明的话序列按顺序把第一条对白配给第一个镜头，而那个镜头根本没台词
    expect(doc.get(seq)?.params?.clips).toEqual([
      { source: v1, in: 0, dialogue: '' },
      { source: v2, in: 0, dialogue: a2 },
    ])
  })

  it('更新展开补了台词：配音接进序列并补上这段的对白，用户调过的入点不动', () => {
    const s = shot(1)
    const { doc, engine, board, table } = setup([s])
    const seq = addSequence(doc)
    expandShots(engine, board, [s.id], catalog)
    const [clip] = doc.get(seq)!.params!.clips as Array<{ source: string }>
    setParam(doc, seq, 'clips', [{ ...clip, in: 1.5, dialogue: '' }])

    table([{ ...s, dialogue: [{ character: '林夏', line: '补的一句' }] }])
    expandShots(engine, board, [s.id], catalog, { mode: 'update' })
    const speech = nodesOf(engine, board, s.id).find((el) => roleOf(el) === 'speech')!
    expect(intoSeq(doc, seq)).toContainEqual([speech.id, 'dialogue'])
    expect(doc.get(seq)?.params?.clips).toEqual([
      { source: clip!.source, in: 1.5, dialogue: speech.id },
    ])
    // 再更新一次不会重复连线
    expandShots(engine, board, [s.id], catalog, { mode: 'update' })
    expect(intoSeq(doc, seq)).toHaveLength(2)
  })

  it('有多个序列时不猜，一条线都不连', () => {
    const s = shot(1)
    const { doc, engine, board } = setup([s])
    const a = addSequence(doc, 800)
    const b = addSequence(doc, 1200)
    expect(expandShots(engine, board, [s.id], catalog).sequence).toBe('ambiguous')
    expect(intoSeq(doc, a)).toEqual([])
    expect(intoSeq(doc, b)).toEqual([])
  })
})

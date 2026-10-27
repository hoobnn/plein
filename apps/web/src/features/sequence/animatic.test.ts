import { describeNode } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { useCanvas } from '../../stores/canvas'
import { useCatalog } from '../../stores/catalog'
import type { Engine } from '@plein/canvas-core'
import {
  connect,
  createDoc,
  createElement,
  deleteElements,
  setParam,
  updateElement,
} from '@plein/doc'
import {
  ANIMATIC_TYPE,
  animaticNode,
  arrangeAnimatic,
  SEQUENCE_TYPE,
  sequenceTimeline,
} from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { openAnimatic, refreshAnimatic, relatedSequences, snapshotAnimatic } from './animatic'
import { previewScene } from './scene'

const image = 'a'.repeat(64)
const audio = 'b'.repeat(64)
it('来源列表损坏或镜头标识冲突时拒绝快照，不能当作删除或空分镜', () => {
  const doc = createDoc()
  const valid = { id: 'one', no: 1, duration: 3 }
  const board = createElement(doc, { kind: 'node', x: 0, y: 0, w: 10, h: 10 })
  for (const shots of [
    null,
    'broken',
    [valid, { id: 'two', no: 2, duration: -1 }],
    [valid, { id: 'one', no: 2 }],
    [{ id: '', no: 1 }],
  ]) {
    setParam(doc, board, 'shots', shots)
    expect(() => snapshotAnimatic(doc, board)).toThrow(/来源分镜/)
    expect(doc.get(board)!.params!.shots).toEqual(shots)
  }
  doc.destroy()
})

it('当前采用的图像或配音标识损坏时不产出无法打开的样片参数', () => {
  for (const role of ['image', 'speech']) {
    const doc = createDoc()
    const board = createElement(doc, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      params: {
        shots: [{ id: 'one', no: 1, dialogue: [{ id: 'line', character: '人', line: '你好' }] }],
      },
    })
    const type = role === 'image' ? 'image' : 'audio'
    createElement(doc, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      params: { source: { storyboard: board, shot: 'one', role, dialogueId: 'line' } },
      results: [{ id: 'bad', runId: 'bad', port: type, at: 1, value: { type, assetId: 'broken' } }],
      adopted: 'bad',
    })
    expect(() => snapshotAnimatic(doc, board)).toThrow(/已采用/)
    doc.destroy()
  }
})

it('素材刷新保留人工镜头顺序，追加新镜头并移除已删除镜头', () => {
  const doc = createDoc()
  const board = createElement(doc, {
    kind: 'node',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    params: {
      shots: [
        { id: 'one', no: 1, duration: 3 },
        { id: 'two', no: 2, duration: 4 },
        { id: 'new', no: 3, duration: 5 },
      ],
    },
  })
  const old = animaticNode.params.parse({
    shots: [
      { shotId: 'two', duration: 7, subtitle: '手工字幕' },
      { shotId: 'one', duration: 2 },
    ],
  }).shots
  const refreshed = snapshotAnimatic(doc, board, old)
  expect(refreshed.map((shot) => shot.shotId)).toEqual(['two', 'one', 'new'])
  expect(refreshed[0]).toMatchObject({ duration: 7, subtitle: '手工字幕' })
  setParam(doc, board, 'shots', [
    { id: 'new', no: 1, duration: 8 },
    { id: 'two', no: 2, duration: 4 },
  ])
  const deleted = snapshotAnimatic(doc, board, refreshed)
  expect(deleted.map((shot) => shot.shotId)).toEqual(['two', 'new'])
  expect(deleted[1]?.duration).toBe(5)
  setParam(doc, board, 'shots', [])
  expect(snapshotAnimatic(doc, board, deleted)).toEqual([])
  doc.destroy()
})

it('更新快照只读取采用的素材并按稳定镜头保留自定义节奏', () => {
  const doc = createDoc()
  const boardId = createElement(doc, {
    kind: 'node',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    params: {
      shots: [
        { id: 's1', no: 1, duration: 5, dialogue: [{ id: 'd1', character: '人', line: '你好' }] },
        { id: 's2', no: 2, duration: 3 },
      ],
    },
  })
  for (const [role, type, assetId] of [
    ['image', 'image', image],
    ['speech', 'audio', audio],
  ] as const)
    createElement(doc, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      params: { source: { storyboard: boardId, shot: 's1', role, dialogueId: 'd1' } },
      results: [{ id: role, runId: 'old', port: type, at: 1, value: { type, assetId } }],
      adopted: role,
    })
  const old = animaticNode.params.parse({
    shots: [{ shotId: 's1', duration: 7, lineDelay: 0.5, lineGap: 0.7 }],
  }).shots
  const result = snapshotAnimatic(doc, boardId, old)
  expect(result[0]).toMatchObject({
    shotId: 's1',
    duration: 7,
    lineDelay: 0.5,
    lineGap: 0.7,
    imageAssetId: image,
    dialogue: [{ assetId: audio }],
  })
  expect(result[1]).toMatchObject({ shotId: 's2', duration: 3, dialogue: [] })
  expect(result[1]?.imageAssetId).toBeUndefined()
})
describe('样片预览', () => {
  it('图片不用视频解码、缺图保留编辑时长；已有对白按延迟与句间停顿排程', () => {
    const params = animaticNode.params.parse({
      subtitles: false,
      shots: [
        {
          shotId: 's',
          imageAssetId: image,
          duration: 5,
          lineDelay: 0.3,
          lineGap: 0.6,
          dialogue: [
            { source: 'a', assetId: audio },
            { source: 'b', assetId: audio },
          ],
        },
        { shotId: 'missing', duration: 3 },
      ],
    })
    const rows = arrangeAnimatic(params)
    const timeline = sequenceTimeline(params, rows, { clips: [5, 3], dialogue: [1], more: [[1]] })
    const scene = previewScene(
      rows.map((r) => ({ ...r, pending: !r.clip.assetId })),
      timeline,
      params,
    )
    expect(scene.clips).toMatchObject([
      { kind: 'image', length: 5 },
      { kind: 'image', length: 3, assetId: undefined },
    ])
    expect(scene.sounds[0]?.start).toBeCloseTo(0.3)
    expect(scene.sounds[1]?.start).toBeCloseTo(1.9)
    expect(scene.sounds).toHaveLength(2)
    expect(scene.total).toBe(8)
  })
})

it('新快照跳过删除/清空/脱离的台词，重排按稳定id及旧文本匹配的新顺序', () => {
  for (const legacy of [false, true]) {
    const doc = createDoc()
    const boardId = createElement(doc, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      params: {
        shots: [
          {
            id: 's',
            no: 1,
            duration: 5,
            dialogue: [
              { id: 'b', character: '人', line: '乙' },
              { id: 'a', character: '人', line: '甲' },
              { id: 'empty', character: '人', line: '' },
            ],
          },
        ],
      },
    })
    const ids = ['a', 'b', 'removed', 'empty', 'detached'].map((dialogueId, i) =>
      createElement(doc, {
        kind: 'node',
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        params: {
          text: ['甲', '乙', '删除', '空', '脱离'][i],
          source: {
            storyboard: boardId,
            shot: 's',
            role: 'speech',
            line: i,
            ...(!legacy ? { dialogueId } : {}),
            ...(dialogueId === 'detached' ? { detached: true } : {}),
          },
        },
        results: [
          {
            id: dialogueId,
            port: 'audio',
            runId: 'old',
            at: 1,
            value: { type: 'audio', assetId: audio },
          },
        ],
        adopted: dialogueId,
      }),
    )
    const actual = snapshotAnimatic(doc, boardId)[0]!.dialogue.map((d) => d.source)
    expect(actual).toEqual([ids[1], ids[0]])
    doc.destroy()
  }
})

describe('样片的成片关联', () => {
  const media = { video: 'video', speech: 'audio', sfx: 'audio' } as const
  const port = { video: 'clips', speech: 'dialogue', sfx: 'sfx' } as const
  function related(
    role: 'video' | 'speech' | 'sfx',
    source: { shot?: string; detached?: boolean; dialogueId?: string },
    shot: Record<string, unknown> = {},
  ) {
    const doc = createDoc()
    const node = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      createElement(doc, { kind: 'node', x: 0, y: 0, w: 10, h: 10, params, ...extra })
    const board = node(
      { shots: [{ id: 'one', no: 1, duration: 3, ...shot }] },
      { nodeType: 'plein/storyboard' },
    )
    const from = node(
      { source: { storyboard: board, shot: 'one', role, ...source } },
      {
        nodeType: `plein/${role}`,
        ports: { inputs: [], outputs: [{ id: media[role], type: media[role] }] },
      },
    )
    const film = node(
      { aspectRatio: '16:9' },
      {
        nodeType: SEQUENCE_TYPE,
        name: '当前成片',
        ports: { inputs: [{ id: port[role], type: media[role], multiple: true }], outputs: [] },
      },
    )
    expect(connect(doc, [from, media[role]], [film, port[role]])).not.toBeNull()
    const draft = node(
      { boardId: board, shots: [{ shotId: 'one', duration: 3, dialogue: [] }] },
      { nodeType: ANIMATIC_TYPE },
    )
    const names = relatedSequences({ doc } as unknown as Engine, draft).map((el) => el.name)
    doc.destroy()
    return names
  }

  it.each([
    ['detached', 'video', { detached: true }],
    ['removed-shot', 'video', { shot: 'removed' }],
    ['speech', 'speech', { dialogueId: 'removed-line' }],
    ['sfx', 'sfx', {}],
  ] as const)('%s 的旧素材不作为当前样片的成片关联', (_, role, source) => {
    expect(related(role, source)).toEqual([])
  })

  it.each([
    ['视频', 'video', {}, {}],
    [
      '当前台词配音',
      'speech',
      { dialogueId: 'line' },
      { dialogue: [{ id: 'line', character: '人', line: '你好' }] },
    ],
    ['当前音效', 'sfx', {}, { sfx: '雷声' }],
  ] as const)('当前镜头的%s有效连线会关联到成片', (_, role, source, shot) => {
    expect(related(role, source, shot)).toEqual(['当前成片'])
  })
})

describe('样片创建与刷新原子性', () => {
  function setup() {
    const canvas = useCanvas.getState()
    const catalog = useCatalog.getState()
    const doc = createDoc(undefined, { schedule: () => {} })
    const board = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/storyboard',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      params: { shots: [{ id: 'one', no: 1, duration: 3 }] },
    })
    const engine = { doc } as unknown as Engine
    useCatalog.setState({
      catalog: { nodes: [describeNode(animaticNode, 'plein/core')] } as unknown as Catalog,
    })
    useCanvas.setState({ engine, canvasId: 'canvas', sequence: null })
    const dispose = () => {
      doc.destroy()
      useCanvas.setState(canvas, true)
      useCatalog.setState(catalog, true)
    }
    return { doc, board, engine, dispose }
  }
  it('损坏来源拒绝首次创建，修复后创建一次；只读可打开已有快照且不刷新', () => {
    const f = setup()
    try {
      setParam(f.doc, f.board, 'shots', null)
      expect(openAnimatic(f.engine, f.board)).toBeUndefined()
      expect([...f.doc.elements()].filter((el) => el.nodeType === ANIMATIC_TYPE)).toHaveLength(0)
      setParam(f.doc, f.board, 'shots', [{ id: 'one', no: 1, duration: 3 }])
      const id = openAnimatic(f.engine, f.board)!
      expect(f.doc.get(id)!.params!.shots).toMatchObject([{ shotId: 'one', duration: 3 }])
      setParam(f.doc, f.board, 'shots', [{ id: 'one', no: 1, duration: 8 }])
      f.doc.readOnly = true
      expect(openAnimatic(f.engine, f.board)).toBe(id)
      expect(useCanvas.getState().sequence).toBe(id)
      expect(f.doc.get(id)!.params!.shots).toMatchObject([{ duration: 3 }])
      expect([...f.doc.elements()].filter((el) => el.nodeType === ANIMATIC_TYPE)).toHaveLength(1)
    } finally {
      f.dispose()
    }
  })
  it('只读首次创建零写入，恢复后可创建；错误刷新保留整个快照，重试独立撤销', () => {
    const f = setup()
    try {
      f.doc.readOnly = true
      expect(openAnimatic(f.engine, f.board)).toBeUndefined()
      f.doc.readOnly = false
      const id = openAnimatic(f.engine, f.board)!
      const before = f.doc.get(id)!.params
      setParam(f.doc, f.board, 'shots', [{ id: 'one', no: 1, duration: -1 }])
      expect(refreshAnimatic(f.engine, id)).toContain('已有样片与节奏已保留')
      expect(f.doc.get(id)!.params).toEqual(before)
      setParam(f.doc, f.board, 'shots', [
        { id: 'one', no: 1, duration: 9 },
        { id: 'two', no: 2, duration: 4 },
      ])
      f.doc.undo.clear()
      updateElement(f.doc, id, { name: '保留改名' })
      expect(refreshAnimatic(f.engine, id)).toBeNull()
      const after = f.doc.get(id)!.params
      expect(after!.shots).toMatchObject([{ duration: 3 }, { duration: 4 }])
      f.doc.undo.undo()
      expect(f.doc.get(id)!.params).toEqual(before)
      expect(f.doc.get(id)!.name).toBe('保留改名')
      f.doc.undo.redo()
      expect(f.doc.get(id)!.params).toEqual(after)
      f.doc.readOnly = true
      expect(refreshAnimatic(f.engine, id)).toContain('只读')
      f.doc.readOnly = false
      deleteElements(f.doc, [f.board])
      expect(refreshAnimatic(f.engine, id)).toContain('来源分镜已删除')
      expect(f.doc.get(id)!.params).toEqual(after)
    } finally {
      f.dispose()
    }
  })
})

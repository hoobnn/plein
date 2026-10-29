import {
  addResults,
  addSourceUnit,
  captureSourceSnapshot,
  connect,
  createElement,
  creativeReviewTarget,
  markSourceRead,
  recordCreativeReview,
  setParam,
  setSourceLink,
  setUnitDisposition,
} from '@plein/doc'
import { box, node, openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import { shotScenes, storyboardPrep, storyboardSceneOptions } from './prepModel'

const docs: ReturnType<typeof openDoc>[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

function fixture(shots: Shot[]) {
  const doc = openDoc()
  docs.push(doc)
  const boardId = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      params: { shots },
      ports: {
        inputs: [{ id: 'script', label: '剧本', type: 'text', multiple: true }],
        outputs: [{ id: 'shots', label: '分镜', type: 'json' }],
      },
    }),
  )
  const shot = (no: number, patch: Partial<Shot> = {}) =>
    Shot.parse({
      id: `shot-${no}`,
      no,
      description: `画面 ${no}`,
      imagePrompt: `首帧 ${no}`,
      motionPrompt: '缓慢推进',
      ...patch,
    })
  return { doc, boardId, shot }
}

function card(doc: ReturnType<typeof openDoc>, nodeType: string, name: string, id?: string) {
  return createElement(
    doc,
    node({
      id,
      nodeType,
      name,
      ports: {
        inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
        outputs: [],
      },
    }),
  )
}

describe('逐镜准备模型', () => {
  it('分别报告文本、提示词与未知台词角色，不补写任何内容', () => {
    const shot = Shot.parse({
      id: 'shot-1',
      no: 1,
      dialogue: [
        { id: 'empty-speaker', character: '', line: '旁白内容' },
        { id: 'empty-line', character: '', line: ' ' },
      ],
    })
    const { doc, boardId } = fixture([shot])
    const before = doc.get(boardId)?.params?.shots
    const result = storyboardPrep(doc, boardId, [shot])
    expect(result.shots[0]?.issues).toEqual([
      expect.objectContaining({ id: 'description', category: 'missing', field: 'description' }),
      expect.objectContaining({ id: 'image-prompt', category: 'missing', field: 'imagePrompt' }),
      expect.objectContaining({ id: 'motion-prompt', category: 'missing', field: 'motionPrompt' }),
      expect.objectContaining({
        id: 'dialogue-character:empty-speaker',
        field: 'dialogue',
        dialogueId: 'empty-speaker',
      }),
    ])
    expect(result.count).toBe(4)
    expect(doc.get(boardId)?.params?.shots).toEqual(before)
  })

  it('唯一名称沿用现有解析，重名需要选择，显式绑定失效不退回同名卡', () => {
    const first = Shot.parse({
      id: 'one',
      no: 1,
      description: '画面',
      imagePrompt: '图',
      motionPrompt: '动',
      characters: ['林夏'],
    })
    const { doc, boardId } = fixture([first])
    const one = card(doc, 'plein/character', '林夏', 'character-one')
    card(doc, 'plein/character', '林夏', 'character-two')
    expect(storyboardPrep(doc, boardId, [first]).shots[0]?.issues).toContainEqual(
      expect.objectContaining({ id: 'binding:林夏', label: expect.stringContaining('需要选择') }),
    )

    const bound = { ...first, assetBindings: { 林夏: { elementId: one } } }
    expect(
      storyboardPrep(doc, boardId, [bound]).shots[0]?.issues.some((issue) =>
        issue.id.startsWith('binding:'),
      ),
    ).toBe(false)
    const invalid = { ...first, assetBindings: { 林夏: { elementId: 'deleted' } } }
    expect(storyboardPrep(doc, boardId, [invalid]).shots[0]?.issues).toContainEqual(
      expect.objectContaining({ id: 'binding:林夏', label: expect.stringContaining('失效') }),
    )
  })

  it('角色和场景参考图复用卡片连线事实，场景筛选保留未唯一绑定分组', () => {
    const { doc, boardId, shot } = fixture([])
    const character = card(doc, 'plein/character', '林夏')
    const scene = card(doc, 'plein/scene', '教室')
    const shots = [shot(1, { characters: ['林夏', '教室'] })]
    const initial = storyboardPrep(doc, boardId, shots)
    expect(initial.shots[0]?.issues.map((issue) => issue.id)).toEqual([
      'reference:林夏',
      'reference:教室',
    ])
    expect(shotScenes(doc, shots[0]!)).toEqual([{ key: `asset:${scene}`, label: '教室' }])

    const image = createElement(doc, box({ assetId: 'reference-image' }))
    expect(connect(doc, [image, 'image'], [character, 'references'])).toBeTruthy()
    expect(connect(doc, [image, 'image'], [scene, 'references'])).toBeTruthy()
    expect(storyboardPrep(doc, boardId, shots).count).toBe(0)

    const ambiguous = shot(2, { characters: ['教室'] })
    setParam(doc, boardId, 'shots', [ambiguous])
    card(doc, 'plein/scene', '教室')
    expect(storyboardSceneOptions(doc, [ambiguous])).toEqual([
      { key: 'name:教室', label: '教室（待绑定）' },
    ])
  })

  it('原文未覆盖与失效关联只列为建议，范围外和当前关联不列入', () => {
    const { doc, boardId, shot } = fixture([])
    const shots = [shot(1)]
    setParam(doc, boardId, 'shots', shots)
    doc.flush()
    const source = createElement(doc, {
      kind: 'markdown',
      name: '剧本',
      text: '第一段。\n第二段。\n第三段。',
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    })
    connect(doc, [source, 'text'], [boardId, 'script'])
    const snapshotId = captureSourceSnapshot(doc, boardId, {
      canvasId: 'canvas',
      elementId: source,
      port: 'text',
      expectedText: '第一段。\n第二段。\n第三段。',
    })!
    const first = addSourceUnit(doc, boardId, {
      snapshotId,
      start: 0,
      end: 4,
      kind: 'event',
    })!
    const second = addSourceUnit(doc, boardId, {
      snapshotId,
      start: 5,
      end: 9,
      kind: 'event',
    })!
    const third = addSourceUnit(doc, boardId, {
      snapshotId,
      start: 10,
      end: 14,
      kind: 'event',
    })!
    setUnitDisposition(doc, boardId, third, 'out_of_scope')
    markSourceRead(doc, boardId, snapshotId)
    expect(
      storyboardPrep(doc, boardId, shots).sourceIssues.map((issue) => issue.sourceUnitId),
    ).toEqual([first, second])

    setSourceLink(doc, boardId, { unitId: first, shotId: shots[0]!.id, treatment: 'retain' })
    expect(
      storyboardPrep(doc, boardId, shots).sourceIssues.map((issue) => issue.sourceUnitId),
    ).toEqual([second])
    setParam(doc, boardId, 'shots', [{ ...shots[0]!, description: '已修改画面' }])
    doc.flush()
    const changed = storyboardPrep(doc, boardId, [{ ...shots[0]!, description: '已修改画面' }])
    expect(changed.sourceIssues).toContainEqual(
      expect.objectContaining({
        sourceUnitId: first,
        category: 'source',
        label: expect.stringContaining('建议复核'),
      }),
    )
  })

  it('只有已有节点才列人工审核，全部确认可用后不再列为待办', () => {
    const { doc, boardId, shot } = fixture([])
    const current = shot(1, { dialogue: [], sfx: '' })
    expect(storyboardPrep(doc, boardId, [current]).count).toBe(0)
    const roles = [
      { role: 'image', nodeType: 'plein/image', port: 'images', value: 'image' },
      { role: 'video', nodeType: 'plein/video', port: 'video', value: 'video' },
    ] as const
    for (const item of roles) {
      const id = createElement(
        doc,
        node({
          nodeType: item.nodeType,
          params: { source: { storyboard: boardId, shot: current.id, role: item.role } },
          ports: {
            inputs: [],
            outputs: [{ id: item.port, label: item.port, type: item.value }],
          },
        }),
      )
      addResults(doc, id, [
        {
          id: `result-${item.role}`,
          runId: `run-${item.role}`,
          port: item.port,
          at: 1,
          value: { type: item.value, assetId: `asset-${item.role}` },
        },
      ])
    }
    doc.flush()
    expect(storyboardPrep(doc, boardId, [current]).shots[0]?.issues).toContainEqual(
      expect.objectContaining({ id: 'review', category: 'review' }),
    )
    for (const el of doc.elements()) {
      const target = creativeReviewTarget(el)
      if (target) recordCreativeReview(doc, el.id, { target, status: 'usable' })
    }
    doc.flush()
    expect(storyboardPrep(doc, boardId, [current]).count).toBe(0)
  })
})

import {
  appendShotPlan,
  connect,
  createElement,
  registerContinuitySubject,
  type PleinDoc,
} from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { afterEach, describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import { scenePrep } from './model'

const docs: PleinDoc[] = []
afterEach(() => docs.splice(0).forEach((doc) => doc.destroy()))

function fixture() {
  const doc = openDoc()
  docs.push(doc)
  const sceneId = createElement(
    doc,
    node({
      id: 'scene-roof',
      nodeType: 'plein/scene',
      name: '天台',
      ports: {
        inputs: [{ id: 'references', label: '参考图', type: 'image', multiple: true }],
        outputs: [],
      },
      params: {
        description: '雨后的旧城天台',
        sceneViews: [
          { id: 'door', name: '门口', description: '从楼梯口看向水箱' },
          { id: 'wide', name: '全景', aliases: ['远处'], description: '城市天际线' },
        ],
      },
    }),
  )
  const board = (id: string, name: string, shots: Shot[]) =>
    createElement(
      doc,
      node({
        id,
        nodeType: 'plein/storyboard',
        name,
        params: { shots },
      }),
    )
  const shot = (id: string, no: number, imagePrompt = '', motionPrompt = '') =>
    Shot.parse({
      id,
      no,
      description: id,
      characters: ['天台'],
      assetBindings: { 天台: { elementId: sceneId } },
      imagePrompt,
      motionPrompt,
      dialogue: [],
    })
  return { doc, sceneId, board, shot }
}

describe('场景准备模型', () => {
  it('跨分镜表按表名和镜头号分组，复用视角别名并保留错误引用原文', () => {
    const { doc, sceneId, board, shot } = fixture()
    board('board-b', '第二集', [
      shot('b1', 1, '@天台/门口'),
      shot('b2', 2, '看向@天台/楼梯口。', '转向@天台/水塔'),
      shot('b3', 3, '@天台'),
    ])
    board('board-a', '第一集', [
      shot('a10', 10, '', '镜头转向@天台/门口'),
      shot('a2', 2, '@天台/门口'),
      shot('a3', 3, '@天台/远处'),
      shot('a4', 4, '在@天台/门口，远景@天台'),
      Shot.parse({ id: 'other', no: 5, description: '别的场景' }),
    ])

    const result = scenePrep(doc, sceneId)!
    expect(result.name).toBe('天台')
    expect(result.description).toBe('雨后的旧城天台')
    expect(
      result.views.map(({ view, shots }) => ({
        id: view.id,
        shots: shots.map((shot) => shot.shotId),
      })),
    ).toEqual([
      { id: 'door', shots: ['a2', 'a4', 'a10', 'b1'] },
      { id: 'wide', shots: ['a3'] },
    ])
    expect(result.unspecified.map((shot) => shot.shotId)).toEqual(['b3'])
    expect(result.missing).toEqual([
      expect.objectContaining({
        shotId: 'b2',
        references: [
          { viewName: '楼梯口', reference: '@天台/楼梯口' },
          { viewName: '水塔', reference: '@天台/水塔' },
        ],
      }),
    ])
  })

  it('裸场景引用与错误视角并存时只归入视角不存在', () => {
    const { doc, sceneId, board, shot } = fixture()
    board('board', '分镜表', [shot('mixed', 1, '@天台，再看@天台/水塔')])

    const result = scenePrep(doc, sceneId)!
    expect(result.unspecified).toEqual([])
    expect(result.ambiguous).toEqual([])
    expect(result.missing).toEqual([
      expect.objectContaining({
        shotId: 'mixed',
        references: [{ viewName: '水塔', reference: '@天台/水塔' }],
      }),
    ])
  })

  it('重名与序号越界保留原文和消歧提示，未绑定重名场景仍不猜', () => {
    const { doc, sceneId, board, shot } = fixture()
    createElement(doc, node({ id: 'scene-duplicate', nodeType: 'plein/scene', name: '天台' }))
    const bound = shot('bound', 1)
    const ambiguous = shot('ambiguous', 2, '@天台/门口')
    const outOfRange = shot('out-of-range', 3, '@天台#3/门口')
    const unbound = Shot.parse({
      id: 'unbound',
      no: 4,
      description: '未绑定的重名场景',
      characters: ['天台'],
      imagePrompt: '@天台/门口',
    })
    board('board', '分镜表', [bound, ambiguous, outOfRange, unbound])

    const result = scenePrep(doc, sceneId)!
    expect(result.unspecified.map((shot) => shot.shotId)).toEqual(['bound'])
    expect(result.ambiguous).toEqual([
      expect.objectContaining({
        shotId: 'ambiguous',
        ambiguities: [
          {
            reference: '@天台/门口',
            problem: '画布上有 2 个「天台」，请写成 @天台#1 或 @天台#2',
          },
        ],
      }),
      expect.objectContaining({
        shotId: 'out-of-range',
        ambiguities: [
          {
            reference: '@天台#3/门口',
            problem: '「@天台#3」不存在，画布上「天台」只有 @天台#1、@天台#2',
          },
        ],
      }),
    ])
    expect(result.views.every(({ shots }) => shots.length === 0)).toBe(true)
    expect(result.missing).toEqual([])
  })

  it('读取站位、走位和姿势，没有计划与并发修订分别保留状态', () => {
    const { doc, sceneId, board, shot } = fixture()
    const boardId = board('board', '分镜表', [
      shot('none', 1, '@天台/门口'),
      shot('station', 2, '@天台/门口'),
      shot('walk', 3, '@天台/门口'),
      shot('conflict', 4, '@天台/门口'),
    ])
    const scope = { canvasId: 'canvas', boardId }
    const subjectId = registerContinuitySubject(doc, {
      scope,
      kind: 'character',
      label: '林夏',
    })!
    const save = (
      shotId: string,
      worldPosition: string,
      endPosition = worldPosition,
      expectedHeads: string[] = [],
      target = doc,
    ) =>
      appendShotPlan(target, {
        scope,
        shotId,
        expectedHeads,
        userId: 'local',
        content: {
          start: { [subjectId]: { worldPosition, pose: '扶着门框' } },
          end: { [subjectId]: { worldPosition: endPosition, pose: '扶着门框' } },
          inherits: [],
        },
      })!
    save('station', '门边')
    save('walk', '水箱旁', '楼梯口')
    const root = save('conflict', '门边')
    const raw = new Y.Doc()
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(doc.ydoc))
    const peer = openDoc(raw)
    docs.push(peer)
    save('conflict', '楼梯口', '楼梯口', [root.id])
    save('conflict', '水箱旁', '水箱旁', [root.id], peer)
    Y.applyUpdate(doc.ydoc, Y.encodeStateAsUpdate(raw))

    const shots = scenePrep(doc, sceneId)!.views[0]!.shots
    expect(shots.map((shot) => [shot.shotId, shot.continuity.state])).toEqual([
      ['none', 'none'],
      ['station', 'current'],
      ['walk', 'current'],
      ['conflict', 'conflict'],
    ])
    expect(shots[1]?.continuity).toEqual({
      state: 'current',
      subjects: [
        {
          subjectId,
          label: '林夏',
          start: '门边',
          end: '门边',
          startPose: '扶着门框',
          endPose: '扶着门框',
        },
      ],
    })
    expect(shots[2]?.continuity).toEqual({
      state: 'current',
      subjects: [
        {
          subjectId,
          label: '林夏',
          start: '水箱旁',
          end: '楼梯口',
          startPose: '扶着门框',
          endPose: '扶着门框',
        },
      ],
    })
  })

  it('基础参考图沿用场景卡连线，非场景节点没有准备数据', () => {
    const { doc, sceneId } = fixture()
    const image = createElement(doc, {
      kind: 'image',
      id: 'reference',
      assetId: 'a'.repeat(64),
      x: 0,
      y: 0,
      w: 100,
      h: 80,
    })
    connect(doc, [image, 'image'], [sceneId, 'references'])

    expect(scenePrep(doc, sceneId)?.references).toEqual(['a'.repeat(64)])
    expect(scenePrep(doc, image)).toBeNull()
    expect(scenePrep(doc, 'missing')).toBeNull()
  })
})

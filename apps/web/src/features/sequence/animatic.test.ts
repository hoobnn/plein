import { createDoc, createElement, setParam } from '@plein/doc'
import { animaticNode, arrangeAnimatic, sequenceTimeline } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { snapshotAnimatic } from './animatic'
import { previewScene } from './scene'

const image = 'a'.repeat(64)
const audio = 'b'.repeat(64)
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

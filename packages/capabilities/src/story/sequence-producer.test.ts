import { describe, expect, it } from 'vite-plus/test'
import {
  connect,
  createDoc,
  createElement,
  inputEdges,
  sequenceInstancesOf,
  setParams,
  updateElement,
  type SequenceInstance,
} from '@plein/doc'
import { corePlugin, sequenceNode, Shot } from '@plein/nodes'
import { describeNode } from '@plein/plugin-sdk'
import { nodeElementOf } from './nodes'
import { expandShots, expandedNodes, type ShotSource } from './storyboard'
import { shotSegmentMapping } from './segment-mapping'

const make = (type: string) => {
  const def = corePlugin.nodes.find((node) => node.type === type)
  return def && nodeElementOf(describeNode(def, 'plein/core'))
}
function fixture(version = 2) {
  const doc = createDoc()
  const shots = [1, 2].map((no) =>
    Shot.parse({
      id: `producer-shot-${no}`,
      no,
      duration: 2,
      description: `画面${no}`,
      motionPrompt: '移动',
      imagePrompt: '静帧',
      dialogue: [{ id: `producer-line-${no}`, character: '甲', line: `台词${no}` }],
    }),
  )
  const board = createElement(doc, { ...make('plein/storyboard')!, params: { shots }, x: 0, y: 0 })
  const sequence = createElement(doc, {
    ...make('plein/sequence')!,
    nodeVersion: version,
    x: 1000,
    y: 0,
  })
  const expand = () =>
    expandShots(
      doc,
      board,
      shots.map((s) => s.id),
      make,
    )
  const update = () => expandShots(doc, board, [shots[0]!.id], make, { mode: 'update' })
  const role = (index: number, role: ShotSource['role']) =>
    expandedNodes(doc, board)
      .get(shots[index]!.id)!
      .find((node) => (node.params?.source as ShotSource | undefined)?.role === role)!.id
  return { doc, board, sequence, shots, expand, update, role }
}

describe('P11分镜展开到实际序列生产者', () => {
  it('先放真实catalog v2空序列再展开，保留connect生成的精确实例而不是覆盖回v1', () => {
    const f = fixture()
    try {
      expect(f.expand().sequence).toBe('linked')
      const params = f.doc.get(f.sequence)!.params!
      expect(sequenceNode.params.safeParse(params).success).toBe(true)
      const rows = sequenceInstancesOf(f.doc.get(f.sequence)!)
      expect(rows).toHaveLength(2)
      for (const [index, row] of rows.entries()) {
        expect(row).toMatchObject({
          source: f.role(index, 'video'),
          port: 'video',
          sound: 'legacy',
          dialogue: f.role(index, 'speech'),
        })
        expect(row.clipInstanceId).toBeTruthy()
        expect(f.doc.getEdge(row.edgeId!)?.from).toEqual([row.source, row.port])
        expect(f.doc.getEdge(row.edgeId!)?.to).toEqual([f.sequence, 'clips'])
        expect(
          shotSegmentMapping(f.doc, {
            canvasId: 'canvas',
            boardId: f.board,
            shotId: f.shots[index]!.id,
          }).problem,
        ).toBeUndefined()
      }
      const before = structuredClone(rows)
      f.update()
      expect(sequenceInstancesOf(f.doc.get(f.sequence)!)).toEqual(before)
    } finally {
      f.doc.destroy()
    }
  })

  it('已有固定叙事行与字幕不补回生成依赖；其他新镜仍是独立合法live行', () => {
    const f = fixture()
    const fixed: SequenceInstance = {
      clipInstanceId: 'retained-fixed',
      source: 'deleted-fixed-view',
      port: 'video',
      segment: {
        version: 1,
        segmentId: 'fixed-segment',
        asset: { assetId: 'a'.repeat(64), kind: 'video' },
        duration: 8,
      },
      narrative: { canvasId: 'canvas', boardId: f.board, shotId: f.shots[0]!.id },
      sound: 'native',
      in: 1,
      out: 3,
      speed: 2,
    }
    const track = {
      inputKey: 'retained-manual',
      cues: [
        {
          id: 'cue',
          source: fixed.clipInstanceId,
          start: 0,
          end: 1,
          text: '原字幕',
          hidden: false,
        },
      ],
    }
    try {
      setParams(f.doc, f.sequence, { instanceVersion: 2, clips: [fixed], subtitleTrack: track })
      f.expand()
      const rows = sequenceInstancesOf(f.doc.get(f.sequence)!)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toEqual(fixed)
      expect(rows[1]!.source).toBe(f.role(1, 'video'))
      expect(
        inputEdges(f.doc, f.sequence, 'clips').some((edge) => edge.from[0] === f.role(0, 'video')),
      ).toBe(false)
      expect(f.doc.get(f.sequence)!.params!.subtitleTrack).toEqual(track)
      expect(sequenceNode.params.safeParse(f.doc.get(f.sequence)!.params).success).toBe(true)
    } finally {
      f.doc.destroy()
    }
  })

  it('v2更新只碰精确live legacy行；非legacy、别端口、坏edge与分离配音不被当计划覆盖', () => {
    const f = fixture()
    try {
      f.expand()
      const source = f.role(0, 'video')
      const detached = createElement(f.doc, {
        ...make('plein/speech')!,
        x: 0,
        y: 0,
        params: {
          text: '用户独立内容',
          source: { storyboard: f.board, shot: f.shots[0]!.id, role: 'speech', detached: true },
        },
      })
      const rows = structuredClone(sequenceInstancesOf(f.doc.get(f.sequence)!))
      const first = {
        ...rows[0]!,
        dialogue: detached,
        in: 0.2,
        out: 1.8,
        more: ['external-user-audio'],
      }
      const explicit = {
        ...first,
        clipInstanceId: 'explicit-voice',
        sound: 'voice' as const,
        dialogue: 'explicit-audio',
        more: ['explicit-more'],
      }
      const secondLive = {
        ...rows[0]!,
        clipInstanceId: 'second-live-use',
        in: 0.6,
        out: 1.4,
        speed: 1.2,
      }
      updateElement(f.doc, source, {
        ports: {
          ...f.doc.get(source)!.ports!,
          outputs: [
            ...f.doc.get(source)!.ports!.outputs,
            { id: 'alternate', type: 'video', label: '另一输出' },
          ],
        },
      })
      const alternateEdge = connect(f.doc, [source, 'alternate'], [f.sequence, 'clips'])!
      const alternate = {
        ...first,
        clipInstanceId: 'alternate-output',
        port: 'alternate',
        edgeId: alternateEdge.id,
      }
      const dangling = { ...first, clipInstanceId: 'mismatched-edge', edgeId: 'missing-edge' }
      const historical = {
        ...first,
        clipInstanceId: 'historical-use',
        narrative: {
          canvasId: 'other',
          boardId: f.board,
          shotId: f.shots[0]!.id,
          historical: true,
        },
      }
      const retained = [
        first,
        secondLive,
        explicit,
        { ...explicit, clipInstanceId: 'explicit-native', sound: 'native' as const },
        { ...explicit, clipInstanceId: 'explicit-mix', sound: 'mix' as const },
        alternate,
        dangling,
        historical,
        rows[1]!,
      ]
      setParams(f.doc, f.sequence, { clips: retained })
      f.update()
      const after = sequenceInstancesOf(f.doc.get(f.sequence)!)
      expect(after.map((row) => row.clipInstanceId)).toEqual(
        retained.map((row) => row.clipInstanceId),
      )
      expect(after[0]).toMatchObject({ dialogue: detached, in: 0.2, out: 1.8 })
      expect(after[0]!.more).toContain('external-user-audio')
      expect(after.slice(1)).toEqual(retained.slice(1))
      expect(
        shotSegmentMapping(f.doc, { canvasId: 'canvas', boardId: f.board, shotId: f.shots[0]!.id })
          .problem,
      ).toBeTruthy()
    } finally {
      f.doc.destroy()
    }
  })

  it('已标记v2的坏行保持可见，不过滤为新live行来绕过映射阻塞', () => {
    const f = fixture()
    try {
      const broken = [{ source: 'unmigrated-source', in: 0 }]
      setParams(f.doc, f.sequence, { instanceVersion: 2, clips: broken })
      f.expand()
      expect(f.doc.get(f.sequence)!.params!.clips).toEqual(broken)
      expect(inputEdges(f.doc, f.sequence, 'clips')).toHaveLength(0)
      expect(sequenceNode.params.safeParse(f.doc.get(f.sequence)!.params).success).toBe(false)
      expect(
        shotSegmentMapping(f.doc, {
          canvasId: 'canvas',
          boardId: f.board,
          shotId: f.shots[0]!.id,
          sequenceId: f.sequence,
        }).problem,
      ).toBeTruthy()
    } finally {
      f.doc.destroy()
    }
  })

  it('v1生产者保持旧source键、自动对白与顺序，不引入v2字段', () => {
    const f = fixture(1)
    try {
      f.expand()
      const params = f.doc.get(f.sequence)!.params!
      expect(params.instanceVersion).toBeUndefined()
      const rows = params.clips as Array<Record<string, unknown>>
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.source)).toEqual([f.role(0, 'video'), f.role(1, 'video')])
      expect(rows.map((row) => row.dialogue)).toEqual([f.role(0, 'speech'), f.role(1, 'speech')])
      expect(
        rows.every(
          (row) =>
            row.clipInstanceId === undefined && row.port === undefined && row.sound === undefined,
        ),
      ).toBe(true)
      expect(sequenceNode.params.safeParse(params).success).toBe(true)
    } finally {
      f.doc.destroy()
    }
  })
})

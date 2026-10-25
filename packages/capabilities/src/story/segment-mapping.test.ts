import { createDoc, createElement, setParam } from '@plein/doc'
import { node } from '@plein/doc/testing'
import { Shot } from '@plein/nodes'
import { describe, expect, it } from 'vite-plus/test'
import { shotSegmentMapping } from './segment-mapping'

function fixture() {
  const doc = createDoc()
  const board = createElement(
    doc,
    node({
      nodeType: 'plein/storyboard',
      params: {
        shots: [1, 2].map((no) =>
          Shot.parse({ id: `shot-${no}`, no, duration: 5, description: '画面' }),
        ),
      },
    }),
  )
  const segment = {
    version: 1 as const,
    segmentId: 'fixed-segment',
    asset: { assetId: 'a'.repeat(64), kind: 'video' as const },
    duration: 8,
  }
  const row = (id: string, shot = 'shot-1') => ({
    clipInstanceId: id,
    source: 'deleted-view',
    port: 'video',
    in: 0,
    out: 2,
    sound: 'native' as const,
    segment,
    narrative: { canvasId: 'canvas', boardId: board, shotId: shot },
  })
  const sequence = (clips: unknown[]) =>
    createElement(
      doc,
      node({ nodeType: 'plein/sequence', nodeVersion: 2, params: { instanceVersion: 2, clips } }),
    )
  return {
    doc,
    board,
    row,
    sequence,
    scope: { canvasId: 'canvas', boardId: board, shotId: 'shot-1' },
  }
}
describe('真实叙事范围与固定段映射', () => {
  it('相同segment的多实例/多sequence只列真实唯一使用者，未选范围明确阻塞', () => {
    const f = fixture()
    const first = f.sequence([f.row('a'), f.row('b')])
    f.sequence([f.row('c', 'shot-2')])
    expect(shotSegmentMapping(f.doc, f.scope).problem).toContain('多个序列')
    const mapping = shotSegmentMapping(f.doc, { ...f.scope, sequenceId: first })
    expect(mapping.problem).toBeUndefined()
    expect(mapping.instances).toHaveLength(2)
    expect(mapping.users).toHaveLength(3)
    expect(
      new Set(mapping.users.map((user) => `${user.sequenceId}/${user.clipInstanceId}`)).size,
    ).toBe(3)
    f.doc.destroy()
  })
  it('损坏fixed行不能被过滤后退成无映射，segment身份冲突明确阻塞', () => {
    const f = fixture(),
      original = f.row('a')
    const id = f.sequence([
      {
        ...original,
        segment: { ...original.segment, asset: { ...original.segment.asset, assetId: 'invalid' } },
      },
    ])
    expect(shotSegmentMapping(f.doc, f.scope).problem).toContain('损坏')
    setParam(f.doc, id, 'clips', [original])
    f.sequence([
      {
        ...f.row('b', 'shot-2'),
        segment: {
          ...original.segment,
          asset: { ...original.segment.asset, assetId: 'b'.repeat(64) },
        },
      },
    ])
    expect(shotSegmentMapping(f.doc, { ...f.scope, sequenceId: id }).problem).toContain('不同文件')
    f.doc.destroy()
  })
  it('已删shot残边、错role端口、失效对白与历史narrative均不成为当前关联', () => {
    for (const variant of ['deleted-shot', 'wrong-port', 'deleted-dialogue', 'historical']) {
      const f = fixture()
      const seq = f.sequence(
        variant === 'historical'
          ? [{ ...f.row('a'), narrative: { ...f.row('a').narrative, historical: true } }]
          : [],
      )
      if (variant !== 'historical') {
        const source = createElement(
          f.doc,
          node({
            nodeType: 'plein/video',
            params: {
              source: {
                storyboard: f.board,
                shot: variant === 'deleted-shot' ? 'deleted-shot' : 'shot-1',
                role: variant === 'deleted-dialogue' ? 'speech' : 'video',
                dialogueId: 'removed-line',
              },
            },
          }),
        )
        const targetPort =
          variant === 'wrong-port'
            ? 'dialogue'
            : variant === 'deleted-dialogue'
              ? 'dialogue'
              : 'clips'
        f.doc.edgeMap.set('controlled-invalid-edge', {
          id: 'controlled-invalid-edge',
          from: [source, 'video'],
          to: [seq, targetPort],
        })
        if (targetPort === 'clips')
          setParam(f.doc, seq, 'clips', [
            {
              clipInstanceId: 'live',
              source,
              port: 'video',
              edgeId: 'controlled-invalid-edge',
              in: 0,
              sound: 'legacy',
            },
          ])
      }
      expect(shotSegmentMapping(f.doc, f.scope).sequenceIds, variant).toEqual([])
      expect(shotSegmentMapping(f.doc, { ...f.scope, sequenceId: seq }).problem, variant).toContain(
        '未关联',
      )
      setParam(f.doc, f.board, 'shots', [])
      expect(shotSegmentMapping(f.doc, f.scope).problem).toContain('镜头已不存在')
      f.doc.destroy()
    }
  })
})

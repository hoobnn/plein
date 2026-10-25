import { createDoc, createElement, setParam, deleteElements, type NodeResult } from '@plein/doc'
import * as Y from 'yjs'
import { remapDoc } from '../projects/package'
import { describe, expect, it } from 'vite-plus/test'
import { appendDeliveryRecord, freezeDeliveryOrigins } from './delivery'

const box = { x: 0, y: 0, w: 100, h: 100, kind: 'node' as const }
const output = (id: string): NodeResult => ({
  id,
  port: 'video',
  runId: id + '_run',
  at: 100,
  value: { type: 'video', assetId: id + '_film' },
})
describe('导出记录冻结合同', () => {
  it('v2 live关联只补运行前精确冻结身份；固定、显式、历史、错资产/边与无冻结均不猜旧关系', () => {
    const doc = createDoc()
    const source = createElement(doc, {
      ...box,
      params: { source: { storyboard: 'original-board', shot: 'original-shot' } },
    })
    const id = createElement(doc, { ...box, nodeType: 'plein/sequence', nodeVersion: 2 })
    const assetId = 'a'.repeat(64)
    const input = {
      type: 'video' as const,
      kind: 'video' as const,
      assetId,
      source,
      sourcePort: 'video',
      edgeId: 'edge',
    }
    const origins = freezeDeliveryOrigins(doc, { clips: [input] })
    setParam(doc, source, 'source', { storyboard: 'late-board', shot: 'late-shot' })
    const row = {
      clipInstanceId: 'clip',
      source,
      port: 'video',
      edgeId: 'edge',
      sound: 'native',
      in: 1,
      out: 3,
    }
    const actual = {
      source,
      clipInstanceId: 'clip',
      port: 'video',
      edgeId: 'edge',
      assetId,
      sourceIn: 1,
      sourceOut: 3,
      speed: 2,
      start: 0.5,
      end: 1.5,
    }
    const explicit = { canvasId: 'canvas', boardId: 'explicit-board', shotId: 'explicit-shot' }
    const variants = [
      {
        name: 'live',
        row: {},
        actual: {},
        input: {},
        frozen: origins,
        shot: 'original-shot',
        board: 'original-board',
      },
      { name: 'missing-freeze', row: {}, actual: {}, input: {}, frozen: undefined },
      {
        name: 'wrong-asset',
        row: {},
        actual: {},
        input: { assetId: 'b'.repeat(64) },
        frozen: origins,
      },
      { name: 'wrong-edge', row: {}, actual: { edgeId: 'other-edge' }, input: {}, frozen: origins },
      {
        name: 'wrong-instance',
        row: {},
        actual: { clipInstanceId: 'other' },
        input: {},
        frozen: origins,
      },
      {
        name: 'fixed',
        row: {
          segment: {
            version: 1,
            segmentId: 'fixed',
            asset: { assetId, kind: 'video' },
            duration: 8,
          },
        },
        actual: { segmentId: 'fixed' },
        input: {},
        frozen: origins,
      },
      {
        name: 'explicit',
        row: { narrative: explicit },
        actual: { narrative: explicit },
        input: {},
        frozen: origins,
        shot: 'explicit-shot',
        board: 'explicit-board',
      },
      {
        name: 'historical',
        row: { narrative: { ...explicit, historical: true } },
        actual: { narrative: { ...explicit, historical: true } },
        input: {},
        frozen: origins,
      },
      {
        name: 'explicit-evidence-missing',
        row: { narrative: explicit },
        actual: {},
        input: {},
        frozen: origins,
      },
    ]
    for (const v of variants) {
      const result = output(v.name)
      const evidence = { ...actual, ...v.actual }
      appendDeliveryRecord(
        doc,
        id,
        [result],
        { instanceVersion: 2, subtitles: false, clips: [{ ...row, ...v.row }] },
        { clips: [{ ...input, ...v.input }] },
        () => ({ duration: 8 }),
        v.frozen,
        {
          video: [
            {
              type: 'video',
              kind: 'video',
              assetId: result.value.type === 'video' ? result.value.assetId : '',
              clipEvidence: { version: 1, basis: 'executed-sequence-spec', sources: [evidence] },
            },
          ],
        },
      )
      const record = doc.get(id)!.deliveries!.find((d) => d.resultId === result.id)!
      expect(record.sources[0], v.name).toEqual({
        ...evidence,
        ...(v.shot ? { shotId: v.shot } : {}),
      })
      expect(record.boardId, v.name).toBe(v.board)
    }
    doc.destroy()
  })
  it('v2 without executed clip evidence preserves unknown mapping instead of reconstructing a claim', () => {
    const doc = createDoc()
    const id = createElement(doc, { ...box, nodeType: 'plein/sequence', nodeVersion: 2 })
    appendDeliveryRecord(
      doc,
      id,
      [output('no-evidence')],
      {
        instanceVersion: 2,
        subtitles: false,
        clips: [
          {
            clipInstanceId: 'fixed',
            source: 'deleted-view',
            port: 'video',
            sound: 'native',
            in: 0,
            out: 2,
            segment: {
              version: 1,
              segmentId: 'segment',
              asset: { assetId: 'a'.repeat(64), kind: 'video' },
              duration: 8,
            },
            narrative: { canvasId: 'canvas', boardId: 'board', shotId: 'shot' },
          },
        ],
      },
      {},
      () => ({ duration: 8 }),
    )
    expect(doc.get(id)!.deliveries![0]!.sources).toEqual([])
    expect(doc.get(id)!.deliveries![0]!.boardId).toBeUndefined()
    doc.destroy()
  })
  it('实际结果建立版本，来源按冻结剪辑；后续修改不污染原映射，重导出不继承确认', () => {
    const doc = createDoc()
    const a = createElement(doc, {
      ...box,
      params: { source: { storyboard: 'board', shot: 'shot1' } },
    })
    const b = createElement(doc, {
      ...box,
      params: { source: { storyboard: 'board', shot: 'shot2' } },
    })
    const id = createElement(doc, { ...box, nodeType: 'plein/sequence', params: { clips: [] } })
    const frozen = {
      clips: [
        { source: b, in: 1, out: 3 },
        { source: a, in: 0, out: 1 },
      ],
      subtitles: false,
    }
    const inputs = {
      clips: [
        { type: 'video' as const, kind: 'video' as const, assetId: 'a', source: a },
        { type: 'video' as const, kind: 'video' as const, assetId: 'b', source: b },
      ],
    }
    const info = (assetId: string) => ({
      duration: assetId.endsWith('_film') ? 3 : 5,
      width: 1920,
      height: 1080,
    })
    const origins = freezeDeliveryOrigins(doc, inputs)
    setParam(doc, a, 'source', { storyboard: 'changed-board', shot: 'changed-shot' })
    deleteElements(doc, [b])
    appendDeliveryRecord(doc, id, [output('r1')], frozen, inputs, info, origins)
    expect(doc.get(id)?.deliveries?.[0]).toMatchObject({
      resultId: 'r1',
      assetId: 'r1_film',
      duration: 3,
      boardId: 'board',
      version: 'v1',
      sources: [
        { source: b, shotId: 'shot2', start: 0, end: 2 },
        { source: a, shotId: 'shot1', start: 2, end: 3 },
      ],
    })
    appendDeliveryRecord(doc, id, [output('r1')], frozen, inputs, info)
    expect(doc.get(id)?.deliveries).toHaveLength(1)
    setParam(doc, id, 'clips', [{ source: a, in: 0, out: 5 }])
    appendDeliveryRecord(doc, id, [output('r2'), output('r3')], frozen, inputs, info, origins)
    expect(doc.get(id)?.deliveries?.[0]).toMatchObject({ version: 'v2', notes: [] })
    expect(doc.get(id)?.deliveries?.[1]?.version).toBe('v3')
    expect(doc.get(id)?.deliveries?.[0]?.confirmedAt).toBeUndefined()
    expect(doc.get(id)?.params?.clips).toEqual([{ source: a, in: 0, out: 5 }])
    doc.destroy()
  })
  it('缺源时长不猜镜头映射，实际MP4元数据仍可回看', () => {
    const doc = createDoc()
    const id = createElement(doc, { ...box, nodeType: 'plein/sequence' })
    appendDeliveryRecord(
      doc,
      id,
      [output('r')],
      { subtitles: false },
      { clips: [{ type: 'video', kind: 'video', assetId: 'lost', source: 'source' }] },
      (id) => (id === 'r_film' ? { duration: 6, width: 1280, height: 720 } : undefined),
    )
    expect(doc.get(id)?.deliveries?.[0]).toMatchObject({ duration: 6, sources: [] })
    doc.destroy()
  })
})

it('项目副本只重映射交付runId，保留用户原话、asset和时间码', () => {
  const doc = createDoc()
  const id = createElement(doc, {
    ...box,
    nodeType: 'plein/sequence',
    deliveries: [
      {
        id: 'd',
        resultId: 'r',
        runId: 'run_old',
        assetId: 'film',
        kind: 'film',
        version: 'v1',
        createdAt: 1,
        width: 1280,
        height: 720,
        duration: 3,
        sources: [],
        notes: [{ id: 'n', time: 1, text: 'run_old', resolved: true }],
        confirmedAt: 2,
      },
    ],
  })
  const copied = createDoc()
  Y.applyUpdate(
    copied.ydoc,
    remapDoc(Y.encodeStateAsUpdate(doc.ydoc), new Map([['run_old', 'run_new']])),
  )
  expect(copied.get(id)?.deliveries?.[0]).toMatchObject({
    runId: 'run_new',
    assetId: 'film',
    confirmedAt: 2,
    notes: [{ time: 1, text: 'run_old' }],
  })
  doc.destroy()
  copied.destroy()
})

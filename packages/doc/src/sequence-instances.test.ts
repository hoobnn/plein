import { describe, expect, it } from 'vite-plus/test'
import * as Y from 'yjs'
import { isSequenceInstance, isVideoSegment, type VideoSegment } from './video-segment'
import { sequenceSegmentAssets } from './sequence-instances'
import {
  createDoc,
  createElement,
  editSequenceInstance,
  setParam,
  sequenceInstancesOf,
  replaceSequenceSegment,
  editDelivery,
  type DeliveryRecord,
  addFixedSequenceInstance,
  deleteElements,
  materializeSequenceV1,
  exportElements,
  importElements,
  addResults,
  connect,
  fixSequenceInstance,
  isGenerationOrigin,
  type NodeResult,
} from './index'

const segment: VideoSegment = {
  version: 1,
  segmentId: 'segment',
  asset: { assetId: 'a'.repeat(64), kind: 'video' },
  duration: 8,
}
const row = {
  clipInstanceId: 'clip',
  source: 'view',
  port: 'video',
  segment,
  sound: 'native',
  in: 0,
}

describe('fixed segment and instance guards', () => {
  it('new image generationOrigin owns input/read metadata while legacy non-video payloads stay unfrozen', () => {
    const doc = createDoc(undefined, { schedule: () => {} })
    const origin = {
      canvasId: 'original-canvas',
      nodeId: 'original-node',
      port: 'image',
      resultId: 'original-result',
      runId: 'original-run',
    }
    const input: NodeResult = {
      id: 'local-result',
      port: 'image',
      runId: 'local-run',
      at: 1,
      value: { type: 'image', assetId: 'a'.repeat(64) },
      generationOrigin: { ...origin },
    }
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/image',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      results: [input],
    })
    doc.undo.clear()
    let updates = 0
    doc.ydoc.on('update', () => updates++)
    const before = Y.encodeStateAsUpdate(doc.ydoc)
    input.generationOrigin!.runId = 'changed-input'
    const read = doc.get(id)!.results![0]!
    expect(() => {
      read.generationOrigin!.runId = 'changed-read'
    }).toThrow()
    expect(() => {
      read.generationOrigin = { ...origin, nodeId: 'replaced' }
    }).toThrow()
    expect(read.generationOrigin).toEqual(origin)
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before)
    expect(updates).toBe(0)
    expect(doc.undo.undoStack).toHaveLength(0)
    expect(Object.isFrozen(read.value)).toBe(false)
    const next: NodeResult = { ...input, id: 'next', generationOrigin: { ...origin } }
    addResults(doc, id, [next])
    const added = Y.encodeStateAsUpdate(doc.ydoc)
    const count = updates
    next.generationOrigin!.canvasId = 'changed-add-input'
    expect(doc.get(id)!.results![0]!.generationOrigin).toEqual(origin)
    expect(() => {
      doc.get(id)!.results![0]!.generationOrigin!.nodeId = 'changed-add-read'
    }).toThrow()
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(added)
    expect(updates).toBe(count)
    const old: NodeResult = {
      id: 'legacy',
      port: 'image',
      runId: 'legacy',
      at: 1,
      value: { type: 'image', assetId: 'legacy' },
    }
    const legacy = createElement(doc, { kind: 'node', x: 0, y: 0, w: 1, h: 1, results: [old] })
    expect(doc.get(legacy)!.results![0]).toBe(old)
    doc.destroy()
  })
  it('copy before fixing preserves only known generation identity and separately captures the local candidate', () => {
    const origin = {
      canvasId: 'original-canvas',
      nodeId: 'actual-generator',
      port: 'video',
      resultId: 'original-result',
      runId: 'original-run',
    }
    for (const known of [false, true])
      for (const crossCanvas of [false, true]) {
        const doc = createDoc()
        const source = createElement(doc, {
          id: 'actual-generator',
          kind: 'node',
          nodeType: 'plein/video',
          ports: { inputs: [], outputs: [{ id: 'video', type: 'video', label: 'video' }] },
          x: 0,
          y: 0,
          w: 100,
          h: 100,
          results: [
            {
              id: 'local-result',
              runId: 'local-run-alias',
              port: 'video',
              at: 1,
              value: { type: 'video', assetId: 'a'.repeat(64) },
              ...(known ? { generationOrigin: origin } : {}),
            },
          ],
        })
        const target = crossCanvas ? createDoc() : doc
        const canvasId = crossCanvas ? 'new-canvas' : 'original-canvas'
        const copied = importElements(target, exportElements(doc, [source]))[0]!
        const seq = createElement(target, {
          kind: 'node',
          nodeType: 'plein/sequence',
          nodeVersion: 2,
          params: { instanceVersion: 2, clips: [] },
          ports: {
            inputs: [{ id: 'clips', type: 'video', multiple: true, label: 'clips' }],
            outputs: [],
          },
          x: 200,
          y: 0,
          w: 100,
          h: 100,
        })
        connect(target, [copied, 'video'], [seq, 'clips'])
        const clip = sequenceInstancesOf(target.get(seq)!)[0]!
        expect(
          fixSequenceInstance(target, seq, clip.clipInstanceId, {
            canvasId,
            assetId: 'a'.repeat(64),
            duration: 8,
            sound: 'native',
          }),
        ).toBe(true)
        const fixed = sequenceInstancesOf(target.get(seq)!)[0]!.segment!
        expect(fixed.origin).toEqual(known ? origin : undefined)
        expect(fixed.selection).toEqual({
          canvasId,
          nodeId: copied,
          port: 'video',
          resultId: 'local-result',
          runId: 'local-run-alias',
        })
        if (crossCanvas) target.destroy()
        doc.destroy()
      }
  })

  it('video result input/read aliases cannot rewrite or fabricate generation identity outside Yjs', () => {
    const doc = createDoc()
    const origin = {
      canvasId: 'original-canvas',
      nodeId: 'node',
      port: 'video',
      resultId: 'r',
      runId: 'original-run',
    }
    const input = {
      id: 'r',
      runId: 'local-run',
      port: 'video',
      at: 1,
      value: { type: 'video' as const, assetId: 'a'.repeat(64) },
      generationOrigin: { ...origin },
    }
    const source = createElement(doc, {
      kind: 'node',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      results: [input],
    })
    doc.undo.clear()
    let updates = 0
    doc.ydoc.on('update', () => updates++)
    const bytes = Y.encodeStateAsUpdate(doc.ydoc)
    input.generationOrigin.runId = 'outside'
    input.value.assetId = 'b'.repeat(64)
    expect(() => {
      doc.get(source)!.results![0]!.generationOrigin!.canvasId = 'forged'
    }).toThrow()
    expect(() => {
      doc.get(source)!.results = []
    }).toThrow()
    expect(doc.get(source)!.results![0]!.generationOrigin).toEqual(origin)
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(bytes)
    expect(updates).toBe(0)
    expect(doc.undo.undoStack).toHaveLength(0)
    const added: NodeResult = { ...input, id: 'unknown', generationOrigin: undefined }
    addResults(doc, source, [added])
    const after = Y.encodeStateAsUpdate(doc.ydoc)
    const count = updates
    added.generationOrigin = origin
    expect(doc.get(source)!.results![0]!.generationOrigin).toBeUndefined()
    expect(() => {
      doc.get(source)!.results![0]!.generationOrigin = origin
    }).toThrow()
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(after)
    expect(updates).toBe(count)
    expect(isGenerationOrigin(origin)).toBe(true)
    expect(isGenerationOrigin({ ...origin, runId: undefined })).toBe(false)
    expect(isVideoSegment({ ...segment, selection: { ...origin, nodeId: undefined } })).toBe(false)
    doc.destroy()
  })

  it('historical selected candidate identity also constrains reuse of a segment id', () => {
    const doc = createDoc()
    const selected = { canvasId: 'c', nodeId: 'n', port: 'video', resultId: 'r', runId: 'run' }
    const seq = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      params: { instanceVersion: 2, clips: [] },
      deliveries: [
        {
          id: 'd',
          resultId: 'd',
          runId: 'd',
          assetId: 'film',
          kind: 'film',
          version: 'v1',
          createdAt: 1,
          width: 1,
          height: 1,
          duration: 2,
          sources: [
            {
              source: 'deleted',
              segmentId: segment.segmentId,
              clipInstanceId: 'old',
              assetId: segment.asset.assetId,
              selection: selected,
              start: 0,
              end: 2,
            },
          ],
          notes: [],
        },
      ],
    })
    for (const changed of [true, false]) {
      const view = createElement(doc, {
        kind: 'video',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        assetId: segment.asset.assetId,
        videoSegment: {
          ...segment,
          selection: { ...selected, runId: changed ? 'different' : selected.runId },
        },
      })
      expect(!!addFixedSequenceInstance(doc, seq, view, { sound: 'native' })).toBe(!changed)
      deleteElements(doc, [view])
    }
    doc.destroy()
  })

  it('unmapped old manual cues retain the original track and reason without a guessed active binding', () => {
    const oldTrack = {
      inputKey: '{"clips":[]}',
      cues: [
        {
          id: 'manual',
          source: 'deleted-video',
          start: 0.2,
          end: 1,
          text: '@林夏 original manual',
          hidden: true,
        },
      ],
    }
    const migrated = materializeSequenceV1(
      'sequence',
      { clips: [], subtitleTrack: oldTrack },
      [],
      () => false,
    )
    const track = migrated.subtitleTrack as {
      inputKey: string
      cues: unknown[]
      unmappedCues: Array<{ cue: unknown; reason: string }>
      legacyTrack: unknown
    }
    expect(track.cues).toEqual([])
    expect(track.inputKey).toBe(oldTrack.inputKey)
    expect(track.legacyTrack).toEqual(oldTrack)
    expect(track.unmappedCues[0]!.cue).toEqual(oldTrack.cues[0])
    expect(track.unmappedCues[0]!.reason).toContain('未绑定')
    oldTrack.cues[0]!.text = 'external mutation'
    expect((track.unmappedCues[0]!.cue as { text: string }).text).toBe('@林夏 original manual')
  })

  it('a segment identity retained only in delivery history rejects changed asset/origin but accepts the same known facts', () => {
    const doc = createDoc()
    const origin = {
      canvasId: 'old-canvas',
      nodeId: 'old-node',
      port: 'video',
      resultId: 'old-result',
      runId: 'old-run',
    }
    const record: DeliveryRecord = {
      id: 'd',
      resultId: 'r',
      runId: 'export-run',
      assetId: 'e'.repeat(64),
      kind: 'film',
      version: 'v1',
      createdAt: 1,
      width: 1280,
      height: 720,
      duration: 2,
      notes: [],
      sources: [
        {
          source: 'deleted',
          clipInstanceId: 'old-use',
          segmentId: 'kept',
          assetId: 'a'.repeat(64),
          origin,
          sourceIn: 4,
          sourceOut: 6,
          speed: 1,
          start: 0,
          end: 2,
        },
      ],
    }
    const sequence = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      params: { instanceVersion: 2, clips: [] },
      deliveries: [record],
    })
    const video = (assetId: string, runId: string) =>
      createElement(doc, {
        kind: 'video',
        assetId,
        videoSegment: {
          version: 1,
          segmentId: 'kept',
          asset: { assetId, kind: 'video' },
          duration: 8,
          origin: { ...origin, runId },
        },
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      })
    const wrongAsset = video('b'.repeat(64), origin.runId)
    expect(addFixedSequenceInstance(doc, sequence, wrongAsset, { sound: 'native' })).toBeUndefined()
    deleteElements(doc, [wrongAsset])
    const wrongOrigin = video('a'.repeat(64), 'different-run')
    expect(
      addFixedSequenceInstance(doc, sequence, wrongOrigin, { sound: 'native' }),
    ).toBeUndefined()
    deleteElements(doc, [wrongOrigin])
    const same = video('a'.repeat(64), origin.runId)
    expect(addFixedSequenceInstance(doc, sequence, same, { sound: 'native' })).toEqual(
      expect.any(String),
    )
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]!.segment!.duration).toBe(8)
    expect(doc.get(sequence)!.deliveries![0]!.sources[0]!.sourceOut).toBe(6)
    doc.destroy()
  })
  it.each(['valid', 'invalid', 'undefined'] as const)(
    'legacy delivery with %s subtitleEvidence owns input/read snapshots while explicit feedback still writes',
    (kind) => {
      const doc = createDoc(undefined, { schedule: () => {} })
      const evidence =
        kind === 'undefined'
          ? undefined
          : {
              version: kind === 'valid' ? 1 : 0,
              basis: kind === 'valid' ? 'executed-sequence-spec' : 'invalid-retained-evidence',
              enabled: true,
              cues: [{ start: 0, end: 2, text: 'executed subtitle @literal' }],
              assetId: 'a'.repeat(64),
              resultId: 'result',
              extra: { values: ['original', 7] },
            }
      const input: DeliveryRecord = {
        id: 'legacy-delivery',
        resultId: 'result',
        runId: 'run',
        assetId: 'a'.repeat(64),
        kind: 'film',
        version: 'v1',
        createdAt: 1,
        width: 1280,
        height: 720,
        duration: 2,
        sources: [{ source: 'legacy-source', start: 0, end: 2 }],
        notes: [],
        subtitleEvidence: evidence as unknown as DeliveryRecord['subtitleEvidence'],
      }
      const expected = evidence === undefined ? undefined : JSON.parse(JSON.stringify(evidence))
      const id = createElement(doc, {
        kind: 'node',
        nodeType: 'plein/sequence',
        nodeVersion: 1,
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        deliveries: [input],
      })
      const { subtitleEvidence: _evidence, ...legacy } = input
      const legacyId = createElement(doc, {
        kind: 'node',
        x: 0,
        y: 0,
        w: 100,
        h: 100,
        deliveries: [legacy],
      })
      expect(doc.get(legacyId)!.deliveries![0]).toBe(legacy)
      expect(Object.isFrozen(legacy)).toBe(false)
      doc.undo.clear()
      let updates = 0
      doc.ydoc.on('update', () => updates++)
      const before = Y.encodeStateAsUpdate(doc.ydoc)
      if (evidence) {
        evidence.cues[0]!.text = 'outside input mutation'
        evidence.assetId = 'b'.repeat(64)
        evidence.extra.values.push('outside input extension')
      }
      expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before)
      const read = doc.get(id)!.deliveries![0]!
      expect(Reflect.set(read, 'subtitleEvidence', { cues: [] })).toBe(false)
      expect(Reflect.set(doc.get(id)!, 'deliveries', [])).toBe(false)
      if (read.subtitleEvidence)
        expect(Reflect.set(read.subtitleEvidence.cues[0]!, 'text', 'outside read mutation')).toBe(
          false,
        )
      expect(read.subtitleEvidence).toEqual(expected)
      expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before)
      expect(updates).toBe(0)
      expect(doc.undo.undoStack).toHaveLength(0)
      const raw = new Y.Doc()
      Y.applyUpdate(raw, before)
      const reloaded = createDoc(raw, { schedule: () => {} })
      expect(reloaded.get(id)!.deliveries![0]!.subtitleEvidence).toEqual(expected)
      expect(Reflect.set(reloaded.get(id)!.deliveries![0]!, 'subtitleEvidence', {})).toBe(false)
      const notes = [{ id: 'n', time: 1, text: 'explicit feedback', resolved: false }]
      expect(editDelivery(doc, id, input.id, { notes })).toBe(true)
      notes[0]!.text = 'outside notes mutation'
      expect(doc.get(id)!.deliveries![0]!.notes[0]!.text).toBe('explicit feedback')
      expect(updates).toBeGreaterThan(0)
      expect(doc.undo.undoStack).toHaveLength(1)
      doc.undo.undo()
      expect(doc.get(id)!.deliveries![0]!.notes).toEqual([])
      doc.undo.redo()
      expect(doc.get(id)!.deliveries![0]!.notes[0]!.text).toBe('explicit feedback')
      expect(editDelivery(doc, id, input.id, { notes: [{ ...notes[0]!, resolved: true }] })).toBe(
        true,
      )
      expect(editDelivery(doc, id, input.id, { confirm: true })).toBe(true)
      expect(doc.get(id)!.deliveries![0]!.confirmedAt).toEqual(expect.any(Number))
      expect(doc.get(id)!.deliveries![0]!.subtitleEvidence).toEqual(expected)
      reloaded.destroy()
      raw.destroy()
      doc.destroy()
    },
  )

  it('typed executed delivery provenance is isolated while explicit notes/confirmation still write', () => {
    const doc = createDoc()
    const input: DeliveryRecord = {
      id: 'd',
      resultId: 'result',
      runId: 'run',
      assetId: 'e'.repeat(64),
      kind: 'film',
      version: 'v1',
      createdAt: 1,
      width: 1280,
      height: 720,
      duration: 2.5,
      notes: [],
      sources: [
        {
          source: 'deleted-view',
          clipInstanceId: 'a',
          segmentId: 'fixed',
          assetId: 'a'.repeat(64),
          origin: {
            canvasId: 'canvas',
            nodeId: 'generator',
            port: 'video',
            resultId: 'seed',
            runId: 'seed-run',
          },
          narrative: { canvasId: 'canvas', boardId: 'board', shotId: 'shot' },
          sourceIn: 0,
          sourceOut: 2,
          speed: 1,
          start: 0,
          end: 2,
        },
      ],
    }
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      deliveries: [input],
    })
    doc.undo.clear()
    let updates = 0
    doc.ydoc.on('update', () => updates++)
    const initial = Y.encodeStateAsUpdate(doc.ydoc)
    input.sources[0]!.assetId = 'b'.repeat(64)
    input.sources[0]!.origin!.runId = 'external-run'
    input.sources[0]!.narrative!.canvasId = 'external-canvas'
    const source = doc.get(id)!.deliveries![0]!.sources[0]!
    for (const mutate of [
      () => {
        source.assetId = 'c'.repeat(64)
      },
      () => {
        source.origin!.resultId = 'external-result'
      },
      () => {
        source.narrative!.shotId = 'external-shot'
      },
    ]) {
      try {
        mutate()
      } catch {
        /* Independent frozen read. */
      }
    }
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(initial)
    expect(updates).toBe(0)
    expect(doc.undo.undoStack).toHaveLength(0)
    expect(doc.get(id)!.deliveries![0]!.sources[0]).toMatchObject({
      assetId: 'a'.repeat(64),
      origin: { runId: 'seed-run', resultId: 'seed' },
      narrative: { canvasId: 'canvas', shotId: 'shot' },
    })
    const notes = [
      { id: 'note', time: 1, text: 'explicit note', resolved: false, clipInstanceId: 'a' },
    ]
    expect(editDelivery(doc, id, 'd', { notes })).toBe(true)
    notes[0]!.text = 'external note mutation'
    expect(doc.get(id)!.deliveries![0]!.notes[0]!.text).toBe('explicit note')
    expect(editDelivery(doc, id, 'd', { confirm: true })).toBe(false)
    expect(
      editDelivery(doc, id, 'd', {
        notes: doc.get(id)!.deliveries![0]!.notes.map((n) => ({ ...n, resolved: true })),
      }),
    ).toBe(true)
    expect(editDelivery(doc, id, 'd', { confirm: true })).toBe(true)
    expect(doc.get(id)!.deliveries![0]!.confirmedAt).toEqual(expect.any(Number))
    expect(doc.get(id)!.deliveries![0]!.sources[0]!.assetId).toBe('a'.repeat(64))
    const target = createDoc()
    const [copied] = importElements(target, exportElements(doc, [id]), { canvasId: 'new-canvas' })
    const history = target.get(copied!)!.deliveries![0]!
    expect(history.historical).toBe(true)
    expect(history.confirmedAt).toBe(doc.get(id)!.deliveries![0]!.confirmedAt)
    expect(history.sources).toEqual(doc.get(id)!.deliveries![0]!.sources)
    expect(editDelivery(target, copied!, 'd', { notes: [] })).toBe(false)
    expect(editDelivery(target, copied!, 'd', { confirm: true })).toBe(false)
    try {
      history.historical = false
    } catch {
      /* Read-only historical marker. */
    }
    expect(target.get(copied!)!.deliveries![0]!.historical).toBe(true)
    target.destroy()
    doc.destroy()
  })
  it('input/get/helper aliases cannot mutate fixed files or origins outside Yjs; explicit replacement remains local', () => {
    const doc = createDoc()
    const input: VideoSegment = {
      ...segment,
      asset: { ...segment.asset },
      origin: {
        canvasId: 'canvas',
        nodeId: 'generator',
        port: 'video',
        resultId: 'selected',
        runId: 'old-run',
      },
    }
    const view = createElement(doc, {
      kind: 'video',
      assetId: input.asset.assetId,
      videoSegment: input,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    })
    const inputRows = [
      { ...row, source: view, segment: input },
      { ...row, clipInstanceId: 'other', source: view, segment: input },
    ]
    const sequence = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      x: 200,
      y: 0,
      w: 100,
      h: 100,
      params: { instanceVersion: 2, clips: inputRows },
    })
    doc.undo.clear()
    let updates = 0
    doc.ydoc.on('update', () => updates++)
    const initial = Y.encodeStateAsUpdate(doc.ydoc)
    const attempt = (change: () => void) => {
      try {
        change()
      } catch {
        /* Read-only snapshots may throw. */
      }
    }
    input.asset.assetId = 'b'.repeat(64)
    input.origin!.runId = 'changed-input'
    attempt(() => {
      doc.get(view)!.videoSegment!.asset.assetId = 'c'.repeat(64)
    })
    attempt(() => {
      doc.get(view)!.videoSegment!.origin!.runId = 'changed-read'
    })
    attempt(() => {
      sequenceInstancesOf(doc.get(sequence)!)[0]!.segment!.asset.assetId = 'd'.repeat(64)
    })
    attempt(() => {
      sequenceInstancesOf(doc.get(sequence)!)[0]!.segment!.origin!.resultId = 'changed-helper'
    })
    attempt(() => {
      ;(doc.get(sequence)!.params!.clips as typeof inputRows)[0]!.in = 5
    })
    expect(updates).toBe(0)
    expect(doc.undo.undoStack).toHaveLength(0)
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(initial)
    expect(doc.get(view)!.videoSegment!.asset.assetId).toBe('a'.repeat(64))
    expect(sequenceInstancesOf(doc.get(sequence)!).map((c) => c.segment!.asset.assetId)).toEqual([
      'a'.repeat(64),
      'a'.repeat(64),
    ])
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]!.segment!.origin!.runId).toBe('old-run')

    const nextInput = {
      ...row,
      source: view,
      segment: {
        ...segment,
        segmentId: 'second',
        asset: { assetId: 'b'.repeat(64), kind: 'video' as const },
      },
    }
    setParam(doc, sequence, 'clips', [nextInput, sequenceInstancesOf(doc.get(sequence)!)[1]!])
    const afterSet = Y.encodeStateAsUpdate(doc.ydoc),
      setUpdates = updates,
      undoSize = doc.undo.undoStack.length
    nextInput.segment.asset.assetId = 'e'.repeat(64)
    attempt(() => {
      sequenceInstancesOf(doc.get(sequence)!)[0]!.segment!.asset.assetId = 'f'.repeat(64)
    })
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(afterSet)
    expect(updates).toBe(setUpdates)
    expect(doc.undo.undoStack).toHaveLength(undoSize)
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]!.segment!.asset.assetId).toBe('b'.repeat(64))

    const third = createElement(doc, {
      kind: 'video',
      assetId: 'c'.repeat(64),
      videoSegment: {
        ...segment,
        segmentId: 'third',
        asset: { assetId: 'c'.repeat(64), kind: 'video' },
      },
      x: 0,
      y: 200,
      w: 100,
      h: 100,
    })
    doc.undo.stopCapturing()
    expect(replaceSequenceSegment(doc, sequence, 'clip', third)).toBe(true)
    expect(sequenceInstancesOf(doc.get(sequence)!).map((c) => c.segment!.asset.assetId)).toEqual([
      'c'.repeat(64),
      'a'.repeat(64),
    ])
    doc.undo.stopCapturing()
    doc.undo.undo()
    expect(sequenceInstancesOf(doc.get(sequence)!).map((c) => c.segment!.asset.assetId)).toEqual([
      'b'.repeat(64),
      'a'.repeat(64),
    ])
    doc.undo.redo()
    expect(sequenceInstancesOf(doc.get(sequence)!).map((c) => c.segment!.asset.assetId)).toEqual([
      'c'.repeat(64),
      'a'.repeat(64),
    ])
    expect(doc.get(view)!.videoSegment!.asset.assetId).toBe('a'.repeat(64))
    doc.destroy()
  })
  it('requires an actual content-addressed file identity and finite observed duration', () => {
    expect(isVideoSegment(segment)).toBe(true)
    for (const assetId of ['', 'not-an-asset', 'A'.repeat(64), 'a'.repeat(63)])
      expect(isVideoSegment({ ...segment, asset: { ...segment.asset, assetId } })).toBe(false)
    for (const duration of [0, -1, NaN, Infinity, '8'])
      expect(isVideoSegment({ ...segment, duration })).toBe(false)
    expect(
      isVideoSegment({
        ...segment,
        origin: { canvasId: 'c', nodeId: 'n', port: 'p', resultId: '', runId: 'r' },
      }),
    ).toBe(false)
  })

  it('rejects malformed instance settings without dropping strong fixed-file references', () => {
    expect(isSequenceInstance(row)).toBe(true)
    const invalid = [
      { in: NaN },
      { in: -1 },
      { out: Infinity },
      { speed: 0 },
      { speed: 5 },
      { volume: 3 },
      { lineDelay: 11 },
      { lineGap: -1 },
      { transitionDuration: 0.1 },
      { transition: 'unknown' },
      { edgeId: '' },
      { subtitle: 7 },
      { more: ['d', 1] },
      { sound: 'legacy' },
      { sound: { toString: () => 'native' } },
      { narrative: { canvasId: 'c', boardId: 'b', shotId: 's', historical: 'yes' } },
    ]
    for (const patch of invalid) {
      const value = { ...row, ...patch }
      expect(isSequenceInstance(value)).toBe(false)
      expect(
        sequenceSegmentAssets({
          nodeType: 'plein/sequence',
          params: { instanceVersion: 2, clips: [value] },
        }),
      ).toEqual(['a'.repeat(64)])
    }
  })

  it('typed edits cannot create NaN rows or discard unrelated malformed legacy settings', () => {
    const doc = createDoc()
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      params: { instanceVersion: 2, clips: [row] },
    })
    expect(editSequenceInstance(doc, id, 'clip', { speed: NaN })).toBe(false)
    expect(doc.get(id)?.params?.clips).toEqual([row])
    doc.destroy()
  })
})

import {
  addResults,
  connect,
  createElement,
  currentResult,
  fixSequenceInstance,
  type HistoryEntry,
  sequenceInstancesOf,
  setParams,
  updateElement,
} from '@plein/doc'
import { node, openDoc } from '@plein/doc/testing'
import { describe, expect, it } from 'vite-plus/test'
import type { ArrangedClip } from '@plein/nodes'
import { arrangeSequence, SequenceClip } from '@plein/nodes'
import * as Y from 'yjs'
import { historyMaterial } from '../../canvas/historyMaterial'
import {
  applyReworkCandidate,
  createReworkDraft,
  currentReworkSource,
  reworkSource,
} from './rework'
const A = 'a'.repeat(64),
  B = 'b'.repeat(64)
function fixture() {
  const doc = openDoc()
  const source = createElement(
    doc,
    node({
      nodeType: 'plein/video',
      name: '原镜头',
      params: { prompt: '@教室/门口 向前走', continuedFrom: { assetId: A } },
      ports: {
        inputs: [{ id: 'refs', label: '参考', type: 'image', multiple: true }],
        outputs: [{ id: 'video', label: '视频', type: 'video' }],
      },
      results: [
        { id: 'r', runId: 'run', port: 'video', at: 1, value: { type: 'video', assetId: A } },
      ],
      adopted: 'r',
    }),
  )
  const sequence = createElement(
    doc,
    node({
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      params: {
        instanceVersion: 2,
        clips: [
          {
            clipInstanceId: 'clip',
            source,
            port: 'video',
            sound: 'voice',
            in: 1,
            out: 3,
            speed: 2,
            dialogue: 'voice',
            subtitle: '原字幕',
          },
        ],
        subtitleTrack: { inputKey: 'old-key', cues: [{ source: 'clip', text: '手改' }] },
      },
    }),
  )
  return { doc, source, sequence }
}
describe('sequence rework isolation', () => {
  it('keeps automatically resolved dialogue and effects when a legacy clip is fixed', () => {
    const { doc, source, sequence } = fixture()
    const legacy = {
      ...sequenceInstancesOf(doc.get(sequence)!)[0]!,
      sound: 'legacy' as const,
      dialogue: undefined,
    }
    setParams(doc, sequence, { clips: [legacy] })
    const draftId = createReworkDraft(doc, doc.get(source)!)!
    const result = {
      id: 'new',
      runId: 'run-new',
      port: 'video',
      at: 2,
      value: { type: 'video' as const, assetId: B },
    }
    addResults(doc, draftId, [result])
    expect(
      applyReworkCandidate(doc, {
        canvasId: 'canvas',
        sequenceId: sequence,
        instanceId: 'clip',
        expected: JSON.stringify(sequenceInstancesOf(doc.get(sequence)!)[0]),
        draftId,
        port: 'video',
        resultId: result.id,
        expectedResult: JSON.stringify(result),
        duration: 5,
        sound: 'mix',
        legacyAudio: { dialogue: 'voice-auto', sfx: 'sfx-auto' },
      }),
    ).toBe(true)
    const rows = sequenceInstancesOf(doc.get(sequence)!)
    const arranged = arrangeSequence(
      { instanceVersion: 2, clips: rows.map((row) => SequenceClip.parse(row)) },
      {
        dialogue: [{ type: 'audio', kind: 'audio', assetId: A, source: 'voice-auto' }],
        sfx: [{ type: 'audio', kind: 'audio', assetId: B, source: 'sfx-auto' }],
      },
    )
    expect(arranged[0]?.dialogue?.source).toBe('voice-auto')
    expect(arranged[0]?.sfx?.source).toBe('sfx-auto')
    expect(arranged[0]?.sound).toBe('mix')
    doc.undo.undo()
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]?.sound).toBe('legacy')
    doc.destroy()
  })
  it('copies current inputs and ordered references without old results, execution identity or adopting the original', () => {
    const { doc, source } = fixture()
    const a = createElement(doc, { kind: 'image', x: 0, y: 0, w: 100, h: 100, assetId: A })
    const b = createElement(doc, { kind: 'image', x: 0, y: 0, w: 100, h: 100, assetId: B })
    connect(doc, [b, 'image'], [source, 'refs'])
    connect(doc, [a, 'image'], [source, 'refs'])
    const id = createReworkDraft(doc, doc.get(source)!)!
    expect(doc.get(id)?.params).toEqual(doc.get(source)?.params)
    expect(doc.get(id)?.results).toBeUndefined()
    expect(doc.get(id)?.adopted).toBeUndefined()
    expect([...doc.edges()].filter((e) => e.to[0] === id).map((e) => e.from[0])).toEqual([b, a])
    expect(currentResult(doc.get(source)!)?.id).toBe('r')
    doc.destroy()
  })
  it('replaces only the selected use, preserves edit settings and stale subtitles, and supports undo', () => {
    const { doc, source, sequence } = fixture()
    const before = sequenceInstancesOf(doc.get(sequence)!)[0]!
    setParams(doc, sequence, { clips: [before, { ...before, clipInstanceId: 'other' }] })
    const draftId = createReworkDraft(doc, doc.get(source)!)!
    const result = {
      id: 'new',
      runId: 'new-run',
      port: 'video',
      at: 2,
      value: { type: 'video' as const, assetId: B },
    }
    addResults(doc, draftId, [result])
    expect(
      applyReworkCandidate(doc, {
        canvasId: 'canvas',
        sequenceId: sequence,
        instanceId: 'clip',
        expected: JSON.stringify(before),
        draftId,
        port: 'video',
        resultId: 'new',
        expectedResult: JSON.stringify(result),
        duration: 5,
        sound: 'native',
      }),
    ).toBe(true)
    const [changed, other] = sequenceInstancesOf(doc.get(sequence)!)
    expect(changed).toMatchObject({
      clipInstanceId: 'clip',
      in: 1,
      out: 3,
      speed: 2,
      sound: 'voice',
      dialogue: 'voice',
      subtitle: '原字幕',
      segment: { asset: { assetId: B } },
    })
    expect(other).toEqual({ ...before, clipInstanceId: 'other' })
    expect(doc.get(sequence)?.params?.subtitleTrack).toMatchObject({ inputKey: 'old-key' })
    expect(currentResult(doc.get(source)!)?.value).toMatchObject({ assetId: A })
    doc.undo.undo()
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]).toEqual(before)
    doc.destroy()
  })
  it('rejects stale instances, locked drafts and too short files without creating material views', () => {
    const { doc, source, sequence } = fixture()
    const raw = sequenceInstancesOf(doc.get(sequence)!)[0]!
    const draftId = createReworkDraft(doc, doc.get(source)!)!
    const result = {
      id: 'new',
      runId: 'new-run',
      port: 'video',
      at: 2,
      value: { type: 'video' as const, assetId: B },
    }
    addResults(doc, draftId, [result])
    const opts = {
      canvasId: 'canvas',
      sequenceId: sequence,
      instanceId: 'clip',
      expected: JSON.stringify(raw),
      draftId,
      port: 'video',
      resultId: 'new',
      expectedResult: JSON.stringify(result),
      duration: 2,
      sound: 'voice' as const,
    }
    const count = [...doc.elements()].length
    expect(applyReworkCandidate(doc, opts)).toBe(false)
    expect(applyReworkCandidate(doc, { ...opts, duration: 8, expected: '{}' })).toBe(false)
    updateElement(doc, draftId, { locked: true })
    expect(applyReworkCandidate(doc, { ...opts, duration: 8 })).toBe(false)
    expect([...doc.elements()]).toHaveLength(count)
    doc.destroy()
  })
  it('rejects malformed or duplicate rows before changing legacy sound or adding a file card', () => {
    const { doc, source, sequence } = fixture()
    const raw = { ...sequenceInstancesOf(doc.get(sequence)!)[0]!, sound: 'legacy' as const }
    setParams(doc, sequence, { clips: [raw, { ...raw }] })
    const draftId = createReworkDraft(doc, doc.get(source)!)!
    const result = {
      id: 'new',
      runId: 'new-run',
      port: 'video',
      at: 2,
      value: { type: 'video' as const, assetId: B },
    }
    addResults(doc, draftId, [result])
    const count = [...doc.elements()].length
    const opts = {
      canvasId: 'canvas',
      sequenceId: sequence,
      instanceId: 'clip',
      expected: JSON.stringify(raw),
      draftId,
      port: 'video',
      resultId: 'new',
      expectedResult: JSON.stringify(result),
      duration: 8,
      sound: 'native' as const,
    }
    expect(applyReworkCandidate(doc, opts)).toBe(false)
    expect([...doc.elements()]).toHaveLength(count)
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]!.sound).toBe('legacy')
    setParams(doc, sequence, { clips: [raw, { broken: true }] })
    expect(applyReworkCandidate(doc, opts)).toBe(false)
    expect([...doc.elements()]).toHaveLength(count)
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]!.sound).toBe('legacy')
    doc.destroy()
  })

  it('resolves fixed local selection only with exact candidate, run and file, never historical origin alone', () => {
    const { doc, source } = fixture()
    const row = {
      source: 'fixed-view',
      port: 'video',
      clip: { assetId: A },
      segment: {
        selection: {
          canvasId: 'canvas',
          nodeId: source,
          port: 'video',
          resultId: 'r',
          runId: 'wrong',
        },
      },
    } as unknown as ArrangedClip
    expect(reworkSource(doc, row, 'canvas')).toBeUndefined()
    row.segment!.selection!.runId = 'run'
    expect(reworkSource(doc, row, 'canvas')?.source.id).toBe(source)
    expect(reworkSource(doc, row, 'other-canvas')).toBeUndefined()
    row.segment!.selection = undefined
    expect(reworkSource(doc, row, 'canvas')).toBeUndefined()
    doc.destroy()
  })
})

describe('history video fixed origin survives reopen', () => {
  it('真实固定后经 Yjs 快照重开仍能核对返工来源', () => {
    const doc = openDoc()
    const source = createElement(
      doc,
      node({
        nodeType: 'plein/video',
        name: '原镜头',
        params: { prompt: '向前走' },
        ports: {
          inputs: [{ id: 'refs', label: '参考', type: 'image', multiple: true }],
          outputs: [{ id: 'video', label: '视频', type: 'video' }],
        },
      }),
    )
    const origin = {
      canvasId: 'canvas',
      nodeId: source,
      port: 'video',
      resultId: 'candidate',
      runId: 'run',
    }
    addResults(
      doc,
      source,
      [
        {
          id: 'candidate',
          runId: 'run',
          port: 'video',
          at: 1,
          generationOrigin: origin,
          value: { type: 'video', assetId: A, mime: 'video/mp4' },
        },
      ],
      { adopt: true },
    )
    const entry: HistoryEntry = {
      elementId: source,
      result: doc.get(source)!.results![0]! as HistoryEntry['result'],
      adopted: true,
    }
    const material = historyMaterial(doc, 'canvas', entry, {
      id: A,
      kind: 'video',
      mime: 'video/mp4',
      name: '片段.mp4',
      size: 1,
      duration: 5,
      width: 1920,
      height: 1080,
      variants: [],
      createdAt: 1,
    })
    if ('problem' in material) throw new Error(material.problem)
    const placed = createElement(doc, { ...material.input, x: 100, y: 100 })
    const sequence = createElement(
      doc,
      node({
        nodeType: 'plein/sequence',
        nodeVersion: 2,
        params: {
          instanceVersion: 2,
          clips: [
            {
              clipInstanceId: 'clip',
              source: placed,
              port: 'video',
              sound: 'native',
              in: 0,
              out: 4,
            },
          ],
        },
        ports: {
          inputs: [{ id: 'clips', label: '片段', type: 'video', multiple: true }],
          outputs: [{ id: 'video', label: '成片', type: 'video' }],
        },
      }),
    )
    expect(
      fixSequenceInstance(doc, sequence, 'clip', {
        canvasId: 'canvas',
        assetId: A,
        duration: 5,
        sound: 'native',
      }),
    ).toBe(true)
    const fixed = sequenceInstancesOf(doc.get(sequence)!)[0]!
    expect(fixed.segment).toMatchObject({
      duration: 5,
      origin,
      selection: {
        canvasId: 'canvas',
        nodeId: source,
        port: 'video',
        resultId: 'candidate',
        runId: 'run',
      },
    })
    const current = currentReworkSource(doc, sequence, 'clip', 'canvas')
    if ('problem' in current) throw new Error(current.problem)
    expect(current.source.id).toBe(source)
    expect(current.pin).toEqual({ resultId: 'candidate', runId: 'run', assetId: A })

    const reopenedDoc = openDoc(new Y.Doc())
    try {
      Y.applyUpdate(reopenedDoc.ydoc, Y.encodeStateAsUpdate(doc.ydoc))
      reopenedDoc.flush()
      const reopened = currentReworkSource(reopenedDoc, sequence, 'clip', 'canvas')
      if ('problem' in reopened) throw new Error(reopened.problem)
      expect(reopened.source.id).toBe(source)
      expect(reopened.pin).toEqual({ resultId: 'candidate', runId: 'run', assetId: A })
      expect(sequenceInstancesOf(reopenedDoc.get(sequence)!)[0]!.segment).toEqual(fixed.segment)
    } finally {
      reopenedDoc.destroy()
      doc.destroy()
    }
  })
})

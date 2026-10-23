import { describe, expect, it } from 'vite-plus/test'
import {
  createDoc,
  createElement,
  sequenceInstancesOf,
  duplicateSequenceInstance,
  fixSequenceInstance,
  editSequenceInstance,
  reorderSequenceInstances,
  deleteElements,
  duplicateElements,
  videoSegmentConflict,
  ReadOnlyDocError,
} from '../../doc/src/index'
import type { PortValue } from '@plein/plugin-sdk'
import { sequenceV1Goldens } from './sequence-v1.fixture'
import {
  arrangeSequence,
  createSubtitleTrack,
  sequenceNode,
  sequenceTimeline,
  sequenceSpec,
  sequenceSourceMap,
  sequenceSourcesAt,
  subtitleTrackStale,
  subtitleInputKey,
  commitSubtitleTrackEdit,
  duplicateInstanceSubtitleTrack,
  retainInstanceSubtitleTrack,
} from './sequence'
import { subtitleSrt } from './interchange'

const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, function (this: unknown, key, item) {
      if (['provenance', 'id'].includes(key)) return undefined
      // 字幕的来源与时间来源是后来补的溯源元数据，实测快照只比对时间与文案
      if (
        (key === 'source' || key === 'origin') &&
        this &&
        typeof this === 'object' &&
        'text' in this
      )
        return undefined
      return item
    }),
  )

describe('sequence instances: old real behavior and fixed uses', () => {
  it('explicit subtitle edits, rebuilds and layout copies preserve unresolved old evidence without rendering it', () => {
    const base = sequenceNode.params.parse({
      instanceVersion: 2,
      clips: [
        {
          clipInstanceId: 'a',
          source: 'view',
          port: 'video',
          sound: 'native',
          in: 0,
          out: 2,
          subtitle: 'active',
          segment: {
            version: 1,
            segmentId: 'fixed',
            asset: { assetId: 'a'.repeat(64), kind: 'video' },
            duration: 8,
          },
        },
      ],
    })
    const rows = arrangeSequence(base, {}),
      durations = { clips: [8], dialogue: [undefined] }
    const track = createSubtitleTrack(base, rows, durations)
    const old = {
      id: 'orphan',
      source: 'deleted',
      start: 0,
      end: 1,
      text: '@林夏 old manual',
      hidden: true,
    }
    track.unmappedCues = [{ cue: old, reason: '来源已删除，未绑定' }]
    track.legacyTrack = { inputKey: 'original old key', cues: [old] }
    const before = sequenceNode.params.parse({ ...base, subtitleTrack: track })
    const changed = commitSubtitleTrackEdit(
      before,
      rows,
      track.cues.map((c) => ({ ...c, text: 'edited active' })),
    )
    expect(changed.unmappedCues).toEqual(track.unmappedCues)
    expect(createSubtitleTrack(before, rows, durations).legacyTrack).toEqual(track.legacyTrack)
    const after = sequenceNode.params.parse({
      ...before,
      clips: [...before.clips, { ...before.clips[0]!, clipInstanceId: 'b' }],
    })
    const copied = duplicateInstanceSubtitleTrack(
      before,
      rows,
      after,
      arrangeSequence(after, {}),
      'a',
      'b',
    )!
    expect(copied.unmappedCues).toEqual(track.unmappedCues)
    expect(copied.legacyTrack).toEqual(track.legacyTrack)
    expect(
      retainInstanceSubtitleTrack(before, rows, { ...before, clips: [] }, [])!.unmappedCues,
    ).toEqual(track.unmappedCues)
    expect(
      sequenceSpec(before, rows, durations, undefined).subtitles!.cues.map((c) => c.text),
    ).toEqual(['active'])
  })
  for (const golden of sequenceV1Goldens)
    it(`preserves measured v1 ${golden.id}`, () => {
      const doc = createDoc()
      for (const element of golden.document.elements) createElement(doc, element)
      for (const edge of golden.document.edges) doc.edgeMap.set(edge.id, edge)
      doc.meta.set('schemaVersion', 10)
      doc.migrate()
      const sequence = doc.get('sequence-v1')!
      expect(sequence.nodeVersion).toBe(2)
      const params = sequenceNode.params.parse(sequence.params)
      const inputs: Record<string, PortValue[]> = {}
      for (const binding of golden.bindings)
        (inputs[binding.edge.to[1]] ??= []).push({
          ...binding.inputValue,
          sourcePort: binding.edge.from[1],
          edgeId: binding.edge.id,
        })
      const rows = arrangeSequence(params, inputs)
      const durations = {
        ...golden.durations,
        dialogue: golden.durations.dialogue.map((d) => d ?? undefined),
        more: golden.durations.more.map((list) => list.map((d) => d ?? undefined)),
      }
      const timeline = sequenceTimeline(params, rows, durations)
      const spec = sequenceSpec(params, rows, durations, inputs.music, golden.id)
      expect(plain(timeline)).toEqual(plain(golden.expected.timeline))
      expect(plain(spec)).toEqual(plain(golden.expected.spec))
      expect(subtitleSrt(spec.subtitles?.cues ?? [])).toBe(golden.expected.srt)
      expect(new Set(rows.map((r) => r.clipInstanceId)).size).toBe(rows.length)
      if (golden.expected.savedInputKey) {
        expect(params.subtitleTrack!.inputKey).toBe(golden.expected.savedInputKey)
        expect(subtitleTrackStale(params, rows)).toBe(false)
        expect(new Set(params.subtitleTrack!.cues.map((c) => c.id)).size).toBe(
          params.subtitleTrack!.cues.length,
        )
        const changed = rows.map((r, i) =>
          i ? r : { ...r, clip: { ...r.clip, assetId: 'different' } },
        )
        expect(subtitleTrackStale(params, changed)).toBe(true)
        expect(() => sequenceSpec(params, changed, durations, inputs.music)).toThrow('字幕已过期')
      }
      doc.destroy()
    })

  it('two fixed uses have independent trim, order, sound, subtitle and original generation identity', () => {
    const doc = createDoc()
    const source = createElement(doc, {
      kind: 'node',
      nodeType: 'golden/media',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      ports: { inputs: [], outputs: [{ id: 'video', type: 'video', label: '视频' }] },
      adopted: 'r',
      results: [
        {
          id: 'r',
          runId: 'original-job',
          generationOrigin: {
            canvasId: 'original-canvas',
            nodeId: 'original-generator',
            port: 'video',
            resultId: 'r',
            runId: 'original-job',
          },
          port: 'video',
          at: 1,
          value: { type: 'video', assetId: 'a'.repeat(64) },
        },
      ],
    })
    const id = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      x: 400,
      y: 0,
      w: 100,
      h: 100,
      params: {
        instanceVersion: 2,
        clips: [{ clipInstanceId: 'a', source, port: 'video', in: 0, sound: 'legacy' }],
      },
    })
    expect(
      fixSequenceInstance(doc, id, 'a', {
        canvasId: 'canvas',
        assetId: 'a'.repeat(64),
        duration: 8,
        sound: 'native',
        expectedResultId: 'wrong',
      }),
    ).toBe(false)
    expect(
      fixSequenceInstance(doc, id, 'a', {
        canvasId: 'canvas',
        assetId: 'a'.repeat(64),
        duration: 8,
        sound: 'native',
        expectedResultId: 'r',
      }),
    ).toBe(true)
    const b = duplicateSequenceInstance(doc, id, 'a', { sound: 'native' })!
    editSequenceInstance(doc, id, 'a', { out: 2, subtitle: 'A' })
    editSequenceInstance(doc, id, b, {
      in: 4,
      out: 6,
      speed: 2,
      subtitle: 'B',
      sound: 'voice',
      transition: '叠化',
      transitionDuration: 0.5,
    })
    expect(reorderSequenceInstances(doc, id, ['a', b], 'obsolete')).toBe(false)
    const params = sequenceNode.params.parse(doc.get(id)!.params)
    const rows = arrangeSequence(params, {
      dialogue: [{ type: 'audio', kind: 'audio', assetId: 'auto-voice', source: 'd' }],
    })
    expect(rows.map((r) => [r.clip.assetId, r.volume, r.dialogue])).toEqual([
      ['a'.repeat(64), 1, undefined],
      ['a'.repeat(64), 0, undefined],
    ])
    const durations = { clips: [8, 8], dialogue: [undefined, undefined] }
    const track = createSubtitleTrack(params, rows, durations)
    expect(track.cues.map((c) => c.source)).toEqual(['a', b])
    const saved = sequenceNode.params.parse({ ...params, subtitleTrack: track })
    expect(subtitleTrackStale(saved, rows)).toBe(false)
    expect(subtitleInputKey(saved, rows)).toContain('"version":2')
    const spec = sequenceSpec(saved, rows, durations, undefined)
    const map = sequenceSourceMap(spec)
    expect(sequenceSourcesAt(map, 1.75).map((s) => [s.clipInstanceId, s.sourceTime])).toEqual([
      ['a', 1.75],
      [b, 4.5],
    ])
    expect(map.map((s) => s.origin?.resultId)).toEqual(['r', 'r'])
    expect(map.at(-1)?.end).toBe(2.5)
    const third = { ...params.clips[0]!, clipInstanceId: 'third' }
    const next = sequenceNode.params.parse({ ...saved, clips: [...saved.clips, third] })
    const nextRows = arrangeSequence(next, {})
    const duplicatedTrack = duplicateInstanceSubtitleTrack(
      saved,
      rows,
      next,
      nextRows,
      'a',
      'third',
    )!
    expect(duplicatedTrack.cues.find((c) => c.source === 'third')?.text).toBe('A')
    expect(duplicatedTrack.cues.find((c) => c.source === 'third')?.id).not.toBe(track.cues[0]!.id)
    const staleRows = rows.map((r) => ({ ...r, clip: { ...r.clip, assetId: 'b'.repeat(64) } }))
    expect(() => commitSubtitleTrackEdit(saved, staleRows, track.cues)).toThrow('字幕已过期')
    expect(() =>
      duplicateInstanceSubtitleTrack(saved, staleRows, next, nextRows, 'a', 'third'),
    ).toThrow()
    deleteElements(doc, [source, rows[0]!.source!])
    expect(arrangeSequence(saved, {}).map((r) => r.clip.assetId)).toEqual([
      'a'.repeat(64),
      'a'.repeat(64),
    ])
    expect(videoSegmentConflict(doc.elements(), { ...rows[0]!.segment!, duration: 7 })).toBe(true)
    const copied = duplicateElements(doc, [id])[0]!
    const copy = sequenceInstancesOf(doc.get(copied)!)
    expect(copy.map((c) => c.clipInstanceId)).not.toEqual(['a', b])
    expect(copy.map((c) => c.segment)).toEqual(rows.map((c) => c.segment))
    doc.readOnly = true
    expect(() => duplicateSequenceInstance(doc, id, 'a', { sound: 'native' })).toThrow(
      ReadOnlyDocError,
    )
    doc.destroy()
  })

  it('fixes a specific historical output without changing adoption and rejects removed/wrong-port candidates', () => {
    const doc = createDoc()
    const source = createElement(doc, {
      kind: 'node',
      nodeType: 'golden/media',
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      adopted: 'new',
      results: [
        {
          id: 'new',
          runId: 'job-new',
          port: 'video',
          at: 2,
          value: { type: 'video', assetId: 'c'.repeat(64) },
        },
        {
          id: 'old',
          runId: 'job-old',
          port: 'video',
          at: 1,
          value: { type: 'video', assetId: 'd'.repeat(64) },
        },
        {
          id: 'wrong',
          runId: 'job-old',
          port: 'alternate',
          at: 1,
          value: { type: 'video', assetId: 'd'.repeat(64) },
        },
        {
          id: 'non-video',
          runId: 'job-old',
          port: 'video',
          at: 1,
          value: { type: 'audio', assetId: 'd'.repeat(64) },
        },
      ],
    })
    const sequence = createElement(doc, {
      kind: 'node',
      nodeType: 'plein/sequence',
      nodeVersion: 2,
      x: 400,
      y: 0,
      w: 100,
      h: 100,
      params: {
        instanceVersion: 2,
        clips: [{ clipInstanceId: 'a', source, port: 'video', sound: 'legacy', in: 0 }],
      },
    })
    const options = {
      canvasId: 'canvas',
      assetId: 'd'.repeat(64),
      duration: 8,
      sound: 'native' as const,
    }
    expect(fixSequenceInstance(doc, sequence, 'a', { ...options, resultId: 'missing' })).toBe(false)
    expect(fixSequenceInstance(doc, sequence, 'a', { ...options, resultId: 'wrong' })).toBe(false)
    expect(fixSequenceInstance(doc, sequence, 'a', { ...options, resultId: 'non-video' })).toBe(
      false,
    )
    expect(fixSequenceInstance(doc, sequence, 'a', { ...options, resultId: 'old' })).toBe(true)
    expect(doc.get(source)?.adopted).toBe('new')
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]!.segment?.origin).toBeUndefined()
    expect(sequenceInstancesOf(doc.get(sequence)!)[0]!.segment?.selection?.resultId).toBe('old')
    doc.destroy()
  })
})

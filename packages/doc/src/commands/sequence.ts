import { newId } from '../ids'
import type { PleinDoc } from '../doc'
import { createElement, currentResult, setParams, updateElement } from '../commands'
import { write } from './write'
import {
  materializeSequenceV1,
  sequenceInstancesOf,
  videoSegmentConflict,
} from '../domain/sequence-instances'
import {
  type NarrativeScope,
  type SequenceInstance,
  type SequenceSound,
  type VideoSegment,
  isGenerationOrigin,
  isSequenceInstance,
  isVideoSegment,
} from '../domain/video-segment'

/** Fix the exact selected file. The UI supplies observed duration, never a model request duration. */
export function fixSequenceInstance(
  doc: PleinDoc,
  sequenceId: string,
  clipInstanceId: string,
  options: {
    canvasId: string
    assetId: string
    duration: number
    sound: Exclude<SequenceSound, 'legacy'>
    expectedResultId?: string
    resultId?: string
    expectedRow?: string
    narrative?: NarrativeScope
  },
): boolean {
  return write(doc, () => {
    const sequence = doc.get(sequenceId)
    if (!sequence || sequence.locked) return false
    const clips = sequenceInstancesOf(sequence),
      row = clips.find((c) => c.clipInstanceId === clipInstanceId)
    if (
      !Array.isArray(sequence.params?.clips) ||
      clips.length !== sequence.params.clips.length ||
      new Set(clips.map((c) => c.clipInstanceId)).size !== clips.length
    )
      return false
    if (
      !row ||
      row.segment ||
      (options.expectedRow !== undefined && options.expectedRow !== JSON.stringify(row))
    )
      return false
    const source = doc.get(row.source)
    if (!source || source.locked) return false
    const adopted = source.kind === 'node' ? currentResult(source, row.port) : undefined
    const result =
      source.kind === 'node'
        ? options.resultId
          ? source.results?.find((r) => r.id === options.resultId && r.port === row.port)
          : adopted
        : undefined
    if (
      (source.kind === 'node' && result?.value.type !== 'video') ||
      (options.expectedResultId && adopted?.id !== options.expectedResultId)
    )
      return false
    const actualAsset =
      result && 'assetId' in result.value
        ? result.value.assetId
        : source.kind === 'video'
          ? source.assetId
          : undefined
    if (
      actualAsset !== options.assetId ||
      !options.canvasId ||
      !Number.isFinite(options.duration) ||
      options.duration <= 0
    )
      return false
    const existingSegment = source.kind === 'video' ? source.videoSegment : undefined
    if (
      existingSegment &&
      (source.assetId !== existingSegment.asset.assetId ||
        Math.abs(options.duration - existingSegment.duration) > 1 / 30)
    )
      return false
    const segment: VideoSegment = existingSegment ?? {
      version: 1,
      segmentId: newId('segment'),
      asset: {
        assetId: options.assetId,
        kind: 'video',
        ...(result?.value && 'mime' in result.value && result.value.mime
          ? { mime: result.value.mime }
          : {}),
      },
      duration: options.duration,
      ...(result
        ? {
            ...(isGenerationOrigin(result.generationOrigin)
              ? { origin: result.generationOrigin }
              : {}),
            selection: {
              canvasId: options.canvasId,
              nodeId: source.id,
              port: row.port,
              resultId: result.id,
              runId: result.runId,
            },
          }
        : {}),
    }
    if (!isVideoSegment(segment) || videoSegmentConflict(doc.elements(), segment)) return false
    const view = newId('el')
    const fixed = {
      ...row,
      source: view,
      port: 'video',
      edgeId: undefined,
      segment,
      sound: options.sound,
      narrative: options.narrative ?? row.narrative,
    }
    if (!isSequenceInstance(fixed)) return false
    createElement(doc, {
      id: view,
      kind: 'video',
      name: `${source.name ?? '视频'} · 固定素材`,
      assetId: segment.asset.assetId,
      videoSegment: segment,
      x: sequence.x - 450,
      y: sequence.y,
      w: 320,
      h: 180,
    })
    const next = clips.map((c) => (c === row ? fixed : c))
    setParams(doc, sequenceId, { instanceVersion: 2, clips: next })
    if (row.edgeId && !next.some((c) => !c.segment && c.edgeId === row.edgeId))
      doc.edgeMap.delete(row.edgeId)
    return true
  })
}

/** Append a separate fixed use; no input edge or provider dependency is created. */
export function duplicateSequenceInstance(
  doc: PleinDoc,
  sequenceId: string,
  clipInstanceId: string,
  options: {
    sound: Exclude<SequenceSound, 'legacy'>
    narrative?: NarrativeScope
    expected?: string
  },
): string | undefined {
  return write(doc, () => {
    const sequence = doc.get(sequenceId)
    if (!sequence || sequence.locked) return
    const clips = sequenceInstancesOf(sequence),
      row = clips.find((c) => c.clipInstanceId === clipInstanceId)
    if (
      !Array.isArray(sequence.params?.clips) ||
      clips.length !== sequence.params.clips.length ||
      new Set(clips.map((c) => c.clipInstanceId)).size !== clips.length
    )
      return
    if (
      !row?.segment ||
      (options.expected !== undefined && options.expected !== JSON.stringify(row))
    )
      return
    const id = newId('clip')
    const at = clips.indexOf(row)
    const added = {
      ...row,
      clipInstanceId: id,
      sound: options.sound,
      narrative: options.narrative,
      dialogue: '',
      more: [],
      sfx: '',
    }
    if (!isSequenceInstance(added)) return
    setParams(doc, sequenceId, {
      clips: [...clips.slice(0, at + 1), added, ...clips.slice(at + 1)],
    })
    return id
  })
}

export function editSequenceInstance(
  doc: PleinDoc,
  sequenceId: string,
  clipInstanceId: string,
  patch: Partial<
    Omit<SequenceInstance, 'clipInstanceId' | 'segment' | 'source' | 'port' | 'edgeId'>
  >,
  expected?: string,
): boolean {
  return write(doc, () => {
    const el = doc.get(sequenceId)
    if (!el || el.locked) return false
    const clips = sequenceInstancesOf(el),
      row = clips.find((c) => c.clipInstanceId === clipInstanceId)
    if (!row || (expected !== undefined && JSON.stringify(row) !== expected)) return false
    const immutable = ['clipInstanceId', 'segment', 'source', 'port', 'edgeId']
    if (
      !Array.isArray(el.params?.clips) ||
      clips.length !== el.params.clips.length ||
      new Set(clips.map((c) => c.clipInstanceId)).size !== clips.length
    )
      return false
    const safe = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !immutable.includes(key)),
    )
    const next = { ...row, ...safe }
    if (!isSequenceInstance(next)) return false
    setParams(doc, sequenceId, { clips: clips.map((c) => (c === row ? next : c)) })
    return true
  })
}

export function reorderSequenceInstances(
  doc: PleinDoc,
  sequenceId: string,
  order: readonly string[],
  expected?: string,
): boolean {
  return write(doc, () => {
    const el = doc.get(sequenceId)
    if (!el || el.locked) return false
    const clips = sequenceInstancesOf(el)
    if (
      !Array.isArray(el.params?.clips) ||
      clips.length !== el.params.clips.length ||
      new Set(clips.map((c) => c.clipInstanceId)).size !== clips.length
    )
      return false
    if (
      (expected !== undefined && JSON.stringify(clips) !== expected) ||
      order.length !== clips.length ||
      new Set(order).size !== clips.length ||
      order.some((id) => !clips.some((c) => c.clipInstanceId === id))
    )
      return false
    setParams(doc, sequenceId, {
      clips: order.map((id) => clips.find((c) => c.clipInstanceId === id)!),
    })
    return true
  })
}

export function addFixedSequenceInstance(
  doc: PleinDoc,
  sequenceId: string,
  fixedVideoId: string,
  options: { sound: Exclude<SequenceSound, 'legacy'>; narrative?: NarrativeScope },
): string | undefined {
  return write(doc, () => {
    const sequence = doc.get(sequenceId),
      video = doc.get(fixedVideoId),
      segment = video?.videoSegment
    if (
      !sequence ||
      sequence.locked ||
      sequence.nodeType !== 'plein/sequence' ||
      video?.kind !== 'video' ||
      !isVideoSegment(segment) ||
      video?.assetId !== segment.asset.assetId ||
      videoSegmentConflict(doc.elements(), segment)
    )
      return
    const id = newId('clip')
    const params =
      sequence.params?.instanceVersion === 2
        ? sequence.params
        : materializeSequenceV1(sequenceId, sequence.params ?? {}, [...doc.edges()], (id) =>
            doc.has(id),
          )
    if (!Array.isArray(params.clips) || params.clips.some((c) => !isSequenceInstance(c))) return
    const added = {
      clipInstanceId: id,
      source: fixedVideoId,
      port: 'video',
      segment,
      sound: options.sound,
      narrative: options.narrative,
      in: 0,
      dialogue: '',
      more: [],
      sfx: '',
    }
    if (!isSequenceInstance(added)) return
    setParams(doc, sequenceId, {
      ...params,
      instanceVersion: 2,
      clips: [...(params.clips as unknown[]), added],
    })
    updateElement(doc, sequenceId, { nodeVersion: 2 })
    return id
  })
}

export function removeSequenceInstance(
  doc: PleinDoc,
  sequenceId: string,
  clipInstanceId: string,
): boolean {
  return write(doc, () => {
    const sequence = doc.get(sequenceId)
    if (!sequence || sequence.locked) return false
    const clips = sequenceInstancesOf(sequence),
      row = clips.find((c) => c.clipInstanceId === clipInstanceId)
    if (
      !Array.isArray(sequence.params?.clips) ||
      clips.length !== sequence.params.clips.length ||
      new Set(clips.map((c) => c.clipInstanceId)).size !== clips.length
    )
      return false
    if (!row) return false
    const next = clips.filter((c) => c !== row)
    setParams(doc, sequenceId, { clips: next })
    if (row.edgeId && !next.some((c) => c.edgeId === row.edgeId)) doc.edgeMap.delete(row.edgeId)
    return true
  })
}

/** Explicit replacement affects this instance only; existing trim/subtitle remain reviewable/stale. */
export function replaceSequenceSegment(
  doc: PleinDoc,
  sequenceId: string,
  clipInstanceId: string,
  fixedVideoId: string,
  expected?: string,
): boolean {
  return write(doc, () => {
    const sequence = doc.get(sequenceId),
      video = doc.get(fixedVideoId),
      segment = video?.videoSegment
    if (
      !sequence ||
      sequence.locked ||
      video?.kind !== 'video' ||
      !isVideoSegment(segment) ||
      video?.assetId !== segment.asset.assetId ||
      videoSegmentConflict(doc.elements(), segment)
    )
      return false
    const clips = sequenceInstancesOf(sequence),
      row = clips.find((c) => c.clipInstanceId === clipInstanceId)
    if (
      !Array.isArray(sequence.params?.clips) ||
      clips.length !== sequence.params.clips.length ||
      new Set(clips.map((c) => c.clipInstanceId)).size !== clips.length
    )
      return false
    if (!row || (expected !== undefined && expected !== JSON.stringify(row))) return false
    const replacement = { ...row, source: fixedVideoId, port: 'video', edgeId: undefined, segment }
    if (!isSequenceInstance(replacement)) return false
    const next = clips.map((c) => (c === row ? replacement : c))
    setParams(doc, sequenceId, { clips: next })
    if (row.edgeId && !next.some((c) => !c.segment && c.edgeId === row.edgeId))
      doc.edgeMap.delete(row.edgeId)
    return true
  })
}

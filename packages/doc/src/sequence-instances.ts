import type { CanvasElement, Edge } from './types'
import { compareInputOrder } from './inputs'
import { isSequenceInstance, isVideoSegment, type SequenceInstance } from './video-segment'
import type { VideoSegment } from './video-segment'
import { sequenceSnapshot } from './sequence-snapshot'

/** IDs derive from persisted edge identity, never names, positions or the adopted file. */
export const legacyClipInstanceId = (sequenceId: string, edgeId: string) =>
  `clip:${sequenceId}:${edgeId}`

export function sequenceInstancesOf(
  element: Pick<CanvasElement, 'nodeType' | 'params'>,
): SequenceInstance[] {
  return element.nodeType === 'plein/sequence' &&
    element.params?.instanceVersion === 2 &&
    Array.isArray(element.params.clips)
    ? element.params.clips.filter(isSequenceInstance).map(sequenceSnapshot)
    : []
}

/** Pure old-source-key materialization, also used when importing an old clipboard into a new doc. */
export function materializeSequenceV1(
  sequenceId: string,
  params: Record<string, unknown>,
  edges: readonly Edge[],
  sourceExists: (id: string) => boolean,
): Record<string, unknown> {
  if (params.instanceVersion === 2) return params
  const old = Array.isArray(params.clips) ? params.clips : []
  const settings = new Map(
    old
      .filter((v) => !!v && typeof v === 'object')
      .map((v) => [v.source as string, v as Record<string, unknown>]),
  )
  const order = new Map(old.map((v, i) => [v?.source, i]))
  const connected = edges
    .filter((e) => e.to[0] === sequenceId && e.to[1] === 'clips' && sourceExists(e.from[0]))
    .sort(compareInputOrder)
    .sort((a, b) => {
      const x = order.get(a.from[0]),
        y = order.get(b.from[0])
      return x !== undefined && y !== undefined
        ? x - y
        : x !== undefined
          ? -1
          : y !== undefined
            ? 1
            : 0
    })
  const clips = connected.map((e) => ({
    ...settings.get(e.from[0]),
    clipInstanceId: legacyClipInstanceId(sequenceId, e.id),
    source: e.from[0],
    port: e.from[1],
    edgeId: e.id,
    sound: 'legacy' as const,
    in: settings.get(e.from[0])?.in ?? 0,
  }))
  const track = params.subtitleTrack as { inputKey?: unknown; cues?: unknown } | undefined
  const connectedSources = new Set(clips.map((c) => c.source))
  const oldCues = track && Array.isArray(track.cues) ? (track.cues as unknown[]) : []
  const unmapped = oldCues.flatMap((cue) => {
    const source =
      cue && typeof cue === 'object' && !Array.isArray(cue)
        ? (cue as Record<string, unknown>).source
        : undefined
    return typeof source === 'string' && connectedSources.has(source)
      ? []
      : [
          {
            cue: sequenceSnapshot(cue),
            reason: '旧字幕来源已删除、未连接或身份无效；未绑定到任何新实例',
          },
        ]
  })
  const subtitleTrack =
    track && typeof track.inputKey === 'string' && Array.isArray(track.cues)
      ? {
          ...track,
          keyVersion: 1,
          legacySources: Object.fromEntries(clips.map((c) => [c.clipInstanceId, c.source])),
          ...(unmapped.length
            ? { unmappedCues: unmapped, legacyTrack: sequenceSnapshot(track) }
            : {}),
          cues: clips.flatMap((c) =>
            oldCues.flatMap((cue, i) =>
              cue &&
              typeof cue === 'object' &&
              !Array.isArray(cue) &&
              (cue as Record<string, unknown>).source === c.source
                ? [
                    {
                      ...cue,
                      id: `${String((cue as Record<string, unknown>).id)}:${c.clipInstanceId}:${i}`,
                      source: c.clipInstanceId,
                    },
                  ]
                : [],
            ),
          ),
        }
      : params.subtitleTrack
  return {
    ...params,
    instanceVersion: 2,
    clips,
    legacySourceSettings: old,
    ...(subtitleTrack ? { subtitleTrack } : {}),
  }
}

/** Only typed fixed files are strong references. Historical generation origins remain immutable. */
export function sequenceSegmentAssets(
  element: Pick<CanvasElement, 'videoSegment' | 'nodeType' | 'params' | 'deliveries'>,
): string[] {
  const ids = new Set<string>()
  if (isVideoSegment(element.videoSegment)) ids.add(element.videoSegment.asset.assetId)
  if (
    element.nodeType === 'plein/sequence' &&
    element.params?.instanceVersion === 2 &&
    Array.isArray(element.params.clips)
  )
    for (const clip of element.params.clips)
      if (clip && typeof clip === 'object' && isVideoSegment(clip.segment))
        ids.add(clip.segment.asset.assetId)
  for (const delivery of element.deliveries ?? [])
    for (const source of delivery.sources) if (source.assetId) ids.add(source.assetId)
  return [...ids]
}

export function videoSegmentConflict(
  elements: Iterable<CanvasElement>,
  segment: VideoSegment,
): boolean {
  const identity = (s: VideoSegment) =>
    JSON.stringify([
      s.asset.assetId,
      s.asset.kind,
      s.asset.mime ?? null,
      s.duration,
      ...[s.origin, s.selection].map((o) =>
        o ? [o.canvasId, o.nodeId, o.port, o.resultId, o.runId] : null,
      ),
    ])
  const expected = identity(segment)
  for (const el of elements) {
    const raw =
      el.nodeType === 'plein/sequence' && Array.isArray(el.params?.clips) ? el.params.clips : []
    const values = [el.videoSegment, ...raw.map((c) => c?.segment).filter(isVideoSegment)]
    for (const s of values)
      if (s?.segmentId === segment.segmentId && identity(s) !== expected) return true
    for (const delivery of el.deliveries ?? [])
      for (const source of delivery.sources) {
        if (source.segmentId !== segment.segmentId) continue
        if (
          source.assetId &&
          /^[0-9a-f]{64}$/.test(source.assetId) &&
          source.assetId !== segment.asset.assetId
        )
          return true
        for (const key of ['origin', 'selection'] as const) {
          const origin = source[key]
          if (
            origin &&
            [origin.canvasId, origin.nodeId, origin.port, origin.resultId, origin.runId].every(
              (v) => typeof v === 'string' && v,
            )
          ) {
            if (
              !segment[key] ||
              JSON.stringify([
                origin.canvasId,
                origin.nodeId,
                origin.port,
                origin.resultId,
                origin.runId,
              ]) !==
                JSON.stringify([
                  segment[key].canvasId,
                  segment[key].nodeId,
                  segment[key].port,
                  segment[key].resultId,
                  segment[key].runId,
                ])
            )
              return true
          }
        }
      }
  }
  return false
}

/** Editable narrative bindings follow restored canvases; fixed generation origins and old deliveries do not. */
export function remapSequenceCanvasScopes(
  params: Record<string, unknown>,
  canvases: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (params.instanceVersion !== 2 || !Array.isArray(params.clips)) return params
  return {
    ...params,
    clips: params.clips.map((clip) => {
      if (!isSequenceInstance(clip) || !clip.narrative || !canvases.has(clip.narrative.canvasId))
        return clip
      return {
        ...clip,
        narrative: { ...clip.narrative, canvasId: canvases.get(clip.narrative.canvasId)! },
      }
    }),
  }
}

export function copySequenceParams(
  params: Record<string, unknown>,
  ids: ReadonlyMap<string, string>,
  newClipId: () => string,
  canvasId?: string,
  edgeIds: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> {
  if (params.instanceVersion !== 2 || !Array.isArray(params.clips)) return params
  const clipIds = new Map(
    params.clips.filter(isSequenceInstance).map((c) => [c.clipInstanceId, newClipId()]),
  )
  const ref = (id: string) => ids.get(id) ?? id
  const clips = params.clips.map((value) => {
    if (!isSequenceInstance(value)) return value
    const c = value
    return {
      ...c,
      clipInstanceId: clipIds.get(c.clipInstanceId)!,
      source: ref(c.source),
      // Exact edge IDs are replaced after the copied edges have been allocated.
      edgeId: c.edgeId ? edgeIds.get(c.edgeId) : undefined,
      dialogue: c.dialogue === undefined ? undefined : ref(c.dialogue),
      more: c.more?.map(ref),
      sfx: c.sfx === undefined ? undefined : ref(c.sfx),
      ...(c.narrative
        ? {
            narrative: {
              ...c.narrative,
              boardId: ref(c.narrative.boardId),
              ...(canvasId && ids.has(c.narrative.boardId)
                ? { canvasId, historical: false }
                : canvasId && canvasId !== c.narrative.canvasId
                  ? { historical: true }
                  : {}),
            },
          }
        : {}),
    }
  })
  const track = params.subtitleTrack as
    | {
        inputKey: string
        cues: Array<Record<string, unknown>>
        legacySources?: Record<string, string>
      }
    | undefined
  if (!track || !Array.isArray(track.cues)) return { ...params, clips }
  let inputKey = track.inputKey
  try {
    const key = JSON.parse(inputKey)
    if (Array.isArray(key.clips)) {
      key.clips = key.clips.map((c: Record<string, unknown>) => ({
        ...c,
        ...(typeof c.source === 'string' ? { source: clipIds.get(c.source) ?? ref(c.source) } : {}),
        ...(typeof c.clipInstanceId === 'string'
          ? { clipInstanceId: clipIds.get(c.clipInstanceId) ?? c.clipInstanceId }
          : {}),
        ...(Array.isArray(c.lines)
          ? {
              lines: c.lines.map((l: Record<string, unknown>) => ({
                ...l,
                ...(typeof l.source === 'string' ? { source: ref(l.source) } : {}),
              })),
            }
          : {}),
      }))
      inputKey = JSON.stringify(key)
    }
  } catch {
    /* Unparseable old key remains stale rather than being silently approved. */
  }
  return {
    ...params,
    clips,
    subtitleTrack: {
      ...track,
      inputKey,
      ...(track.legacySources
        ? {
            legacySources: Object.fromEntries(
              Object.entries(track.legacySources).map(([id, src]) => [
                clipIds.get(id) ?? id,
                ref(src),
              ]),
            ),
          }
        : {}),
      cues: track.cues.map((c) => ({
        ...c,
        id: newClipId(),
        source: typeof c.source === 'string' ? (clipIds.get(c.source) ?? c.source) : c.source,
      })),
    },
  }
}

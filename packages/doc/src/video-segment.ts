/** Original execution identity when known, or a separately labelled local candidate selection. */
export interface GenerationOrigin {
  canvasId: string
  nodeId: string
  port: string
  resultId: string
  runId: string
}

/** A fixed file and its known generation origin. Neither an adopted-node alias nor an approval. */
export interface VideoSegment {
  version: 1
  segmentId: string
  asset: { assetId: string; kind: 'video'; mime?: string }
  /** Actual media seconds observed when fixed; exporters still probe the owned file. */
  duration: number
  origin?: GenerationOrigin
  /** Local candidate location when fixed; never proof of its original generation scope. */
  selection?: GenerationOrigin
}

export interface NarrativeScope {
  canvasId: string
  boardId: string
  shotId: string
  historical?: boolean
}

export type SequenceSound = 'legacy' | 'native' | 'voice' | 'mix'

export interface SequenceInstance {
  clipInstanceId: string
  source: string
  port: string
  edgeId?: string
  segment?: VideoSegment
  narrative?: NarrativeScope
  sound: SequenceSound
  in: number
  out?: number
  speed?: number
  volume?: number
  dialogue?: string
  more?: string[]
  sfx?: string
  subtitle?: string
  lineDelay?: number
  lineGap?: number
  transition?: string
  transitionDuration?: number
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const within = (value: unknown, min: number, max = Infinity): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const optional = (value: unknown, valid: (v: unknown) => boolean) =>
  value === undefined || valid(value)

export function isGenerationOrigin(value: unknown): value is GenerationOrigin {
  return (
    object(value) &&
    ['canvasId', 'nodeId', 'port', 'resultId', 'runId'].every((key) => text(value[key]))
  )
}

export function isVideoSegment(value: unknown): value is VideoSegment {
  if (!object(value) || value.version !== 1 || !text(value.segmentId) || !object(value.asset))
    return false
  if (
    typeof value.asset.assetId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.asset.assetId) ||
    value.asset.kind !== 'video' ||
    (value.asset.mime !== undefined && typeof value.asset.mime !== 'string') ||
    typeof value.duration !== 'number' ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0
  )
    return false
  return optional(value.origin, isGenerationOrigin) && optional(value.selection, isGenerationOrigin)
}

export function isSequenceInstance(value: unknown): value is SequenceInstance {
  if (!object(value)) return false
  const narrative = value.narrative
  return (
    text(value.clipInstanceId) &&
    text(value.source) &&
    text(value.port) &&
    typeof value.sound === 'string' &&
    ['legacy', 'native', 'voice', 'mix'].includes(value.sound) &&
    within(value.in, 0) &&
    optional(value.out, (v) => within(v, 0)) &&
    optional(value.speed, (v) => within(v, 0.25, 4)) &&
    optional(value.volume, (v) => within(v, 0, 2)) &&
    optional(value.lineDelay, (v) => within(v, 0, 10)) &&
    optional(value.lineGap, (v) => within(v, 0, 10)) &&
    optional(value.transitionDuration, (v) => within(v, 0.2, 2)) &&
    optional(
      value.transition,
      (v) =>
        typeof v === 'string' && ['无', '淡入淡出', '叠化', '划像', '推移', '闪白'].includes(v),
    ) &&
    optional(value.edgeId, text) &&
    ['dialogue', 'sfx', 'subtitle'].every((key) =>
      optional(value[key], (v) => typeof v === 'string'),
    ) &&
    optional(value.more, (v) => Array.isArray(v) && v.every((item) => typeof item === 'string')) &&
    (value.segment === undefined || (isVideoSegment(value.segment) && value.sound !== 'legacy')) &&
    (narrative === undefined ||
      (object(narrative) &&
        ['canvasId', 'boardId', 'shotId'].every((key) => text(narrative[key])) &&
        optional(narrative.historical, (v) => typeof v === 'boolean')))
  )
}

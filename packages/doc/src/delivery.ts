import { ReadOnlyDocError, updateElement } from './commands'
import type { PleinDoc } from './doc'
import type { NarrativeScope, VideoSegment } from './video-segment'
/** 成片交付元数据：绑定已落盘的结果，不进入模型参数或输入哈希。 */
export interface DeliverySource {
  source: string
  shotId?: string
  start: number
  end: number
  clipInstanceId?: string
  segmentId?: string
  assetId?: string
  port?: string
  edgeId?: string
  origin?: VideoSegment['origin']
  selection?: VideoSegment['selection']
  narrative?: NarrativeScope
  sourceIn?: number
  sourceOut?: number
  speed?: number
}
export interface DeliveryNote {
  id: string
  time: number
  text: string
  resolved: boolean
  source?: string
  shotId?: string
  clipInstanceId?: string
}
/** Only the exact sequenceSpec used by the exporter; this does not prove rendered text/OCR. */
export interface DeliverySubtitleEvidence {
  version: 1
  basis: 'executed-sequence-spec'
  enabled: boolean
  cues: Array<{ start: number; end: number; text: string }>
  assetId: string
  resultId: string
}
export interface DeliveryRecord {
  /** Copies/imports retain the original confirmation as history, never current-scope approval. */
  historical?: boolean
  id: string
  resultId: string
  runId: string
  assetId: string
  kind: 'animatic' | 'film'
  version: string
  createdAt: number
  width: number
  height: number
  duration: number
  boardId?: string
  sources: DeliverySource[]
  notes: DeliveryNote[]
  confirmedAt?: number
  subtitleEvidence?: DeliverySubtitleEvidence
}
export function isDeliveryRecord(value: unknown): value is DeliveryRecord {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<DeliveryRecord>
  return (
    typeof v.id === 'string' &&
    typeof v.resultId === 'string' &&
    typeof v.runId === 'string' &&
    typeof v.assetId === 'string' &&
    (v.kind === 'film' || v.kind === 'animatic') &&
    typeof v.version === 'string' &&
    Number.isFinite(v.createdAt) &&
    Number.isFinite(v.width) &&
    Number.isFinite(v.height) &&
    Number.isFinite(v.duration) &&
    Array.isArray(v.sources) &&
    v.sources.every(
      (s) =>
        !!s &&
        typeof s.source === 'string' &&
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.start >= 0 &&
        s.end >= s.start &&
        (s.shotId === undefined || typeof s.shotId === 'string') &&
        (s.clipInstanceId === undefined || typeof s.clipInstanceId === 'string') &&
        (s.assetId === undefined || /^[0-9a-f]{64}$/.test(s.assetId)) &&
        (s.sourceIn === undefined || (Number.isFinite(s.sourceIn) && s.sourceIn >= 0)) &&
        (s.sourceOut === undefined ||
          (Number.isFinite(s.sourceOut) && s.sourceOut >= (s.sourceIn ?? 0))) &&
        (s.speed === undefined || (Number.isFinite(s.speed) && s.speed > 0)),
    ) &&
    Array.isArray(v.notes) &&
    v.notes.every((n) => validNote(n, v.duration ?? 0)) &&
    (v.confirmedAt === undefined || Number.isFinite(v.confirmedAt)) &&
    (v.historical === undefined || typeof v.historical === 'boolean')
  )
}

/** 反馈操作只改指定的导出版本；重新确认必须在该版本全部意见解决之后。 */
export function editDelivery(
  doc: PleinDoc,
  elementId: string,
  deliveryId: string,
  change: { notes?: DeliveryNote[]; confirm?: boolean },
): boolean {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const el = doc.get(elementId)
  const record = el?.deliveries?.find((r) => r.id === deliveryId)
  if (!record || record.historical) return false
  const notes = change.notes ?? record.notes
  if (notes.some((n) => !validNote(n, record.duration))) return false
  if (change.confirm && notes.some((n) => !n.resolved)) return false
  const next = { ...record, notes: notes.map((n) => ({ ...n })) }
  if (change.notes || change.confirm === false) delete next.confirmedAt
  if (change.confirm) next.confirmedAt = Date.now()
  doc.undo.stopCapturing()
  updateElement(doc, elementId, {
    deliveries: el!.deliveries!.map((r) => (r.id === deliveryId ? next : r)),
  })
  doc.undo.stopCapturing()
  return true
}

function validNote(value: unknown, duration: number): value is DeliveryNote {
  if (!value || typeof value !== 'object') return false
  const n = value as Partial<DeliveryNote>
  return (
    typeof n.id === 'string' &&
    typeof n.time === 'number' &&
    Number.isFinite(n.time) &&
    n.time >= 0 &&
    (duration <= 0 || n.time <= duration) &&
    typeof n.text === 'string' &&
    n.text.trim().length > 0 &&
    n.text.length <= 4000 &&
    typeof n.resolved === 'boolean' &&
    (n.source === undefined || typeof n.source === 'string') &&
    (n.shotId === undefined || typeof n.shotId === 'string') &&
    (n.clipInstanceId === undefined || typeof n.clipInstanceId === 'string')
  )
}

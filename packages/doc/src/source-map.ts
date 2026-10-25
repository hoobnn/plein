import * as Y from 'yjs'
import { ReadOnlyDocError, currentResult } from './commands'
import type { PleinDoc } from './doc'
import { newId } from './ids'
import { inputEdges } from './inputs'

/** 捕获时的历史出处不随复制改写；binding 才是当前文档中的定位。 */
export interface SourceOrigin {
  canvasId: string
  elementId: string
  port: string
  resultId?: string
}
export interface SourceEntry {
  id: string
  activeSnapshotId: string
  binding: { elementId: string; port: string } | null
}
export interface SourceSnapshot {
  id: string
  sourceId: string
  originAtCapture: SourceOrigin
  name: string
  text: string
  capturedAt: number
}
export interface SourceUnit {
  id: string
  snapshotId: string
  start: number
  end: number
  kind: 'event' | 'dialogue'
  disposition: 'in_scope' | 'out_of_scope'
  note: string
}
export interface SourceLink {
  id: string
  unitId: string
  shotId: string
  dialogueId?: string
  treatment: 'retain' | 'compress' | 'merge'
  targetSnapshot: string
}
export interface SourceProposal {
  id: string
  shotIds: string[]
  note: string
}
export interface SourceMapRecord {
  sources: SourceEntry[]
  snapshots: SourceSnapshot[]
  units: SourceUnit[]
  links: SourceLink[]
  proposals: SourceProposal[]
  /** 用户显式声明已核对的版本；不作为内容确认依赖。 */
  readSnapshotIds: string[]
}
export interface SourceInput {
  elementId: string
  port: string
  name: string
  text?: string
  resultId?: string
  problem?: string
}
const keys = ['sources', 'snapshots', 'units', 'links', 'proposals', 'reads'] as const
type Part = (typeof keys)[number]
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const string = (v: unknown): v is string => typeof v === 'string'
const idValid = (v: unknown): v is string => string(v) && !!v
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const valid: Record<Part, (v: unknown) => boolean> = {
  sources: (v) =>
    object(v) &&
    idValid(v.id) &&
    idValid(v.activeSnapshotId) &&
    (v.binding === null ||
      (object(v.binding) && idValid(v.binding.elementId) && idValid(v.binding.port))),
  snapshots: (v) =>
    object(v) &&
    idValid(v.id) &&
    idValid(v.sourceId) &&
    string(v.name) &&
    string(v.text) &&
    Number.isFinite(v.capturedAt) &&
    object(v.originAtCapture) &&
    idValid(v.originAtCapture.canvasId) &&
    idValid(v.originAtCapture.elementId) &&
    idValid(v.originAtCapture.port) &&
    (v.originAtCapture.resultId === undefined || idValid(v.originAtCapture.resultId)),
  units: (v) =>
    object(v) &&
    idValid(v.id) &&
    idValid(v.snapshotId) &&
    Number.isInteger(v.start) &&
    Number.isInteger(v.end) &&
    (v.start as number) >= 0 &&
    (v.end as number) > (v.start as number) &&
    ['event', 'dialogue'].includes(v.kind as string) &&
    ['in_scope', 'out_of_scope'].includes(v.disposition as string) &&
    string(v.note),
  links: (v) =>
    object(v) &&
    idValid(v.id) &&
    idValid(v.unitId) &&
    idValid(v.shotId) &&
    (v.dialogueId === undefined || idValid(v.dialogueId)) &&
    ['retain', 'compress', 'merge'].includes(v.treatment as string) &&
    string(v.targetSnapshot),
  proposals: (v) =>
    object(v) &&
    idValid(v.id) &&
    Array.isArray(v.shotIds) &&
    v.shotIds.every(idValid) &&
    string(v.note) &&
    !!v.note.trim(),
  reads: (v) => v === true,
}
export const emptySourceMap = (): SourceMapRecord => ({
  sources: [],
  snapshots: [],
  units: [],
  links: [],
  proposals: [],
  readSnapshotIds: [],
})
export function createSourceMap(record?: SourceMapRecord): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const key of keys) {
    const entries: [string, unknown][] =
      key === 'reads'
        ? (record?.readSnapshotIds ?? []).map((id) => [id, true])
        : (record?.[key] ?? []).filter(valid[key]).map((v) => [v.id, clone(v)])
    map.set(key, new Y.Map(entries))
  }
  return map
}
export function readSourceMap(value: unknown): SourceMapRecord | undefined {
  if (!(value instanceof Y.Map)) return undefined
  const out = emptySourceMap()
  for (const key of keys) {
    const part = value.get(key)
    if (!(part instanceof Y.Map)) continue
    if (key === 'reads')
      out.readSnapshotIds = [...part.entries()]
        .filter(([, v]) => v === true)
        .map(([id]) => id)
        .sort()
    else
      (out[key] as unknown[]) = [...part.values()]
        .filter(valid[key])
        .map(clone)
        .sort((a, b) => (a as { id: string }).id.localeCompare((b as { id: string }).id))
  }
  // 文件中的不完整/越界标注不能变成有原文依据的映射。
  out.units = out.units.filter((unit) => {
    const snapshot = out.snapshots.find((s) => s.id === unit.snapshotId)
    return (
      snapshot &&
      sourceBoundary(snapshot.text, unit.start) &&
      sourceBoundary(snapshot.text, unit.end) &&
      !!snapshot.text.slice(unit.start, unit.end).trim()
    )
  })
  const unitIds = new Set(out.units.map((u) => u.id))
  out.links = out.links.filter((link) => unitIds.has(link.unitId))
  return out
}
export function sourceMapOf(doc: PleinDoc, boardId: string): SourceMapRecord {
  const production = doc.elementMaps.get(boardId)?.get('production')
  return (
    readSourceMap(production instanceof Y.Map ? production.get('sourceMap') : undefined) ??
    emptySourceMap()
  )
}
function mutate(
  doc: PleinDoc,
  boardId: string,
  fn: (part: (key: Part) => Y.Map<unknown>) => void,
): boolean {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (doc.get(boardId)?.nodeType !== 'plein/storyboard') return false
  const production = doc.elementMaps.get(boardId)?.get('production')
  const map = production instanceof Y.Map ? production.get('sourceMap') : undefined
  // 创建/迁移时预建，避免两位协作者首次操作替换整个子 Map。
  if (!(map instanceof Y.Map) || !keys.every((key) => map.get(key) instanceof Y.Map)) return false
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    doc.mutable(boardId)
    fn((key) => map.get(key) as Y.Map<unknown>)
  }, doc.origin)
  doc.undo.stopCapturing()
  return true
}

/** 与 script 端口的真实来源和采用候选绑定；无文本时不会隐式执行上游。 */
export function readSourceInput(
  doc: PleinDoc,
  elementId: string,
  port: string,
): SourceInput | undefined {
  const el = doc.get(elementId)
  if (!el) return undefined
  const base = { elementId, port, name: el.name ?? elementId }
  if (el.kind === 'markdown') return { ...base, text: el.text ?? '' }
  if (el.nodeType === 'plein/text' && port === 'text')
    return typeof el.params?.text === 'string'
      ? { ...base, text: el.params.text }
      : { ...base, problem: '文本参数不是有效字符串，请先修复来源' }
  const result = currentResult(el, port)
  return result?.value?.type === 'text' && typeof result.value.text === 'string'
    ? { ...base, text: result.value.text, resultId: result.id }
    : { ...base, problem: '此端口尚无采用的文本结果；请先提供文本或采用结果' }
}
export function listSourceInputs(doc: PleinDoc, boardId: string): SourceInput[] {
  const seen = new Set<string>()
  return inputEdges(doc, boardId, 'script').flatMap((edge) => {
    const key = JSON.stringify(edge.from)
    if (seen.has(key)) return []
    seen.add(key)
    const input = readSourceInput(doc, edge.from[0], edge.from[1])
    return input ? [input] : []
  })
}
export function captureSourceSnapshot(
  doc: PleinDoc,
  boardId: string,
  input: {
    canvasId: string
    elementId: string
    port: string
    expectedText: string
    expectedResultId?: string
  },
): string | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (!input.canvasId) return undefined
  const live = listSourceInputs(doc, boardId).find(
    (v) => v.elementId === input.elementId && v.port === input.port,
  )
  if (
    !live ||
    live.text === undefined ||
    !live.text.trim() ||
    live.text !== input.expectedText ||
    live.resultId !== input.expectedResultId
  )
    return undefined
  const record = sourceMapOf(doc, boardId)
  const old = record.sources.find(
    (s) => s.binding?.elementId === input.elementId && s.binding.port === input.port,
  )
  // 首次并发捕获也指向同一来源；快照独立保留，active 指针按 Yjs 收敛。
  const sourceId = old?.id ?? `source-${JSON.stringify([input.elementId, input.port])}`
  const id = `snapshot-${newId('el')}`
  const snapshot: SourceSnapshot = {
    id,
    sourceId,
    text: live.text,
    name: live.name,
    capturedAt: Date.now(),
    originAtCapture: {
      canvasId: input.canvasId,
      elementId: input.elementId,
      port: input.port,
      ...(live.resultId ? { resultId: live.resultId } : {}),
    },
  }
  return mutate(doc, boardId, (part) => {
    part('snapshots').set(id, snapshot)
    part('sources').set(sourceId, {
      id: sourceId,
      activeSnapshotId: id,
      binding: { elementId: input.elementId, port: input.port },
    })
  })
    ? id
    : undefined
}
export function sourceSnapshotState(
  doc: PleinDoc,
  boardId: string,
  snapshot: SourceSnapshot,
): 'current' | 'changed' | 'missing' | 'external' | 'disconnected' {
  const source = sourceMapOf(doc, boardId).sources.find((s) => s.id === snapshot.sourceId)
  if (!source?.binding) return 'external'
  const live = readSourceInput(doc, source.binding.elementId, source.binding.port)
  if (!live) return 'missing'
  if (
    !listSourceInputs(doc, boardId).some(
      (s) => s.elementId === source.binding!.elementId && s.port === source.binding!.port,
    )
  )
    return 'disconnected'
  return live.text === snapshot.text && live.resultId === snapshot.originAtCapture.resultId
    ? 'current'
    : 'changed'
}
/** UTF-16 偏移与 textarea 一致；范围不能劈开代理对。 */
export function sourceBoundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false
  const before = text.charCodeAt(offset - 1),
    after = text.charCodeAt(offset)
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}
export function readSourceSlice(snapshot: SourceSnapshot, offset = 0, limit = 8000) {
  let start = Number.isFinite(offset)
    ? Math.max(0, Math.min(snapshot.text.length, Math.floor(offset)))
    : 0
  if (!sourceBoundary(snapshot.text, start)) start--
  let end = Math.min(
    snapshot.text.length,
    start + Math.max(1, Math.min(16000, Number.isFinite(limit) ? Math.floor(limit) : 8000)),
  )
  if (!sourceBoundary(snapshot.text, end)) end++
  return {
    snapshotId: snapshot.id,
    offset: start,
    end,
    total: snapshot.text.length,
    text: snapshot.text.slice(start, end),
  }
}
export function addSourceUnit(
  doc: PleinDoc,
  boardId: string,
  input: {
    snapshotId: string
    start: number
    end: number
    kind: SourceUnit['kind']
  },
): string | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const snapshot = sourceMapOf(doc, boardId).snapshots.find((s) => s.id === input.snapshotId)
  if (
    !snapshot ||
    !sourceBoundary(snapshot.text, input.start) ||
    !sourceBoundary(snapshot.text, input.end) ||
    input.end <= input.start ||
    !snapshot.text.slice(input.start, input.end).trim() ||
    !['event', 'dialogue'].includes(input.kind)
  )
    return undefined
  const id = `unit-${newId('el')}`
  return mutate(doc, boardId, (part) =>
    part('units').set(id, { id, ...input, disposition: 'in_scope', note: '' }),
  )
    ? id
    : undefined
}
export function markSourceRead(doc: PleinDoc, boardId: string, snapshotId: string): boolean {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (!sourceMapOf(doc, boardId).snapshots.some((s) => s.id === snapshotId)) return false
  return mutate(doc, boardId, (part) => part('reads').set(snapshotId, true))
}
export function setUnitDisposition(
  doc: PleinDoc,
  boardId: string,
  unitId: string,
  disposition: SourceUnit['disposition'],
): boolean {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const unit = sourceMapOf(doc, boardId).units.find((u) => u.id === unitId)
  if (!unit || !['in_scope', 'out_of_scope'].includes(disposition)) return false
  return mutate(doc, boardId, (part) => part('units').set(unitId, { ...unit, disposition }))
}
function targetSnapshot(
  doc: PleinDoc,
  boardId: string,
  shotId: string,
  dialogueId?: string,
): string | undefined {
  const shots = doc.get(boardId)?.params?.shots
  if (!Array.isArray(shots)) return undefined
  const shot: unknown = shots.find((s: unknown) => object(s) && s.id === shotId)
  if (!object(shot)) return undefined
  if (dialogueId) {
    const line: unknown =
      Array.isArray(shot.dialogue) &&
      shot.dialogue.find((d: unknown) => object(d) && d.id === dialogueId)
    return object(line) ? JSON.stringify([line.id, line.character, line.line]) : undefined
  }
  return JSON.stringify([shot.description ?? '', shot.dialogue ?? []])
}
export function sourceLinkState(
  doc: PleinDoc,
  boardId: string,
  link: SourceLink,
): 'current' | 'changed' | 'missing' {
  const current = targetSnapshot(doc, boardId, link.shotId, link.dialogueId)
  return current === undefined ? 'missing' : current === link.targetSnapshot ? 'current' : 'changed'
}
export function setSourceLink(
  doc: PleinDoc,
  boardId: string,
  input: {
    unitId: string
    shotId: string
    dialogueId?: string
    treatment: SourceLink['treatment']
  },
): string | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const record = sourceMapOf(doc, boardId)
  const unit = record.units.find((u) => u.id === input.unitId)
  const target = targetSnapshot(doc, boardId, input.shotId, input.dialogueId)
  if (
    !unit ||
    unit.disposition !== 'in_scope' ||
    target === undefined ||
    !['retain', 'compress', 'merge'].includes(input.treatment)
  )
    return undefined
  // 同一关系使用同一 key，使并发相同操作合并；不同镜头关系独立追加。
  const id = JSON.stringify([input.unitId, input.shotId, input.dialogueId ?? null])
  return mutate(doc, boardId, (part) =>
    part('links').set(id, { id, ...input, targetSnapshot: target }),
  )
    ? id
    : undefined
}
export function removeSourceLink(doc: PleinDoc, boardId: string, linkId: string): boolean {
  return mutate(doc, boardId, (part) => part('links').delete(linkId))
}
export function removeSourceUnit(doc: PleinDoc, boardId: string, unitId: string): boolean {
  const record = sourceMapOf(doc, boardId)
  return mutate(doc, boardId, (part) => {
    part('units').delete(unitId)
    for (const link of record.links) if (link.unitId === unitId) part('links').delete(link.id)
  })
}
export function addAdaptationProposal(
  doc: PleinDoc,
  boardId: string,
  shotIds: string[],
  note: string,
): string | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (!note.trim() || shotIds.some((id) => targetSnapshot(doc, boardId, id) === undefined))
    return undefined
  const id = `proposal-${newId('el')}`
  return mutate(doc, boardId, (part) =>
    part('proposals').set(id, {
      id,
      shotIds: [...new Set(shotIds)],
      note: note.trim().slice(0, 4000),
    }),
  )
    ? id
    : undefined
}
/** 原文全文参与精确比较；读取状态与 UI 偏好不进入内容确认。 */
export function sourceMapContentSnapshot(record?: SourceMapRecord): unknown {
  if (!record || !record.sources.length)
    return record?.proposals.length ? { proposals: record.proposals } : undefined
  const active = new Set(record.sources.map((s) => s.activeSnapshotId))
  const units = record.units.filter((u) => active.has(u.snapshotId))
  const unitIds = new Set(units.map((u) => u.id))
  return {
    sources: record.sources,
    snapshots: record.snapshots.filter((s) => active.has(s.id)),
    units,
    links: record.links.filter((l) => unitIds.has(l.unitId)),
    proposals: record.proposals,
  }
}
/** 只重映射声明的身份，不碰原文。镜头身份由新 boardId + shotId 限定。 */
export function copySourceMap(
  record: SourceMapRecord,
  elementIds: ReadonlyMap<string, string>,
): SourceMapRecord {
  const ids = new Map<string, string>()
  for (const list of [record.sources, record.snapshots, record.units, record.proposals])
    for (const value of list) ids.set(value.id, `source-copy-${newId('el')}`)
  return {
    sources: record.sources.map((s) => ({
      id: ids.get(s.id)!,
      activeSnapshotId: ids.get(s.activeSnapshotId)!,
      binding:
        s.binding && elementIds.has(s.binding.elementId)
          ? { ...s.binding, elementId: elementIds.get(s.binding.elementId)! }
          : null,
    })),
    snapshots: record.snapshots.map((s) => ({
      ...clone(s),
      id: ids.get(s.id)!,
      sourceId: ids.get(s.sourceId)!,
    })),
    units: record.units.map((u) => ({
      ...u,
      id: ids.get(u.id)!,
      snapshotId: ids.get(u.snapshotId)!,
    })),
    links: record.links.map((l) => ({
      ...l,
      id: JSON.stringify([ids.get(l.unitId), l.shotId, l.dialogueId ?? null]),
      unitId: ids.get(l.unitId)!,
    })),
    proposals: record.proposals.map((p) => ({ ...clone(p), id: ids.get(p.id)! })),
    readSnapshotIds: [],
  }
}

import * as Y from 'yjs'
import { ReadOnlyDocError } from './commands'
import type { PleinDoc } from './doc'
import { newId } from './ids'
import type { CanvasElement } from './types'
import {
  continuityContentSnapshot,
  copyContinuity,
  createContinuityMap,
  readContinuity,
  type ContinuityRecord,
} from './continuity'
import {
  copySourceMap,
  createSourceMap,
  readSourceMap,
  sourceMapContentSnapshot,
  type SourceMapRecord,
} from './source-map'
import {
  copyProductionGoals,
  createProductionGoals,
  readProductionGoals,
  type ProductionGoalRevision,
} from './production-goal'

export interface ProductionScope {
  canvasId: string
  boardId: string
}
export interface ProductionActor {
  userId: string
  source: 'ui'
}
export interface ProductionConfirmation {
  id: string
  scope: ProductionScope
  /** 完整、按对象键排序的分镜内容，不用短 hash 代替内容校验。 */
  snapshot: string
  version: string
  actor: ProductionActor
  at: number
  historical?: boolean
}
export interface ProductionDecision {
  id: string
  scope: ProductionScope
  category: 'model' | 'style' | 'other'
  subject: string
  value: string
  note: string
  actor: ProductionActor
  at: number
  historical?: boolean
}
export interface ProductionSelection {
  trialShotId?: string
  sequenceId?: string
}
export interface ProductionRecord {
  selection?: ProductionSelection
  confirmations: ProductionConfirmation[]
  decisions: ProductionDecision[]
  goals?: ProductionGoalRevision[]
  sourceMap?: SourceMapRecord
  continuity?: ContinuityRecord
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const scopeValid = (v: unknown): v is ProductionScope =>
  object(v) &&
  typeof v.canvasId === 'string' &&
  !!v.canvasId &&
  typeof v.boardId === 'string' &&
  !!v.boardId
const actorValid = (v: unknown): v is ProductionActor =>
  object(v) && v.source === 'ui' && typeof v.userId === 'string' && !!v.userId.trim()
const eventValid = (v: unknown) =>
  object(v) &&
  typeof v.id === 'string' &&
  !!v.id &&
  scopeValid(v.scope) &&
  actorValid(v.actor) &&
  typeof v.at === 'number' &&
  Number.isFinite(v.at) &&
  (v.historical === undefined || typeof v.historical === 'boolean')
const confirmationValid = (v: unknown): v is ProductionConfirmation =>
  eventValid(v) && object(v) && typeof v.snapshot === 'string' && typeof v.version === 'string'
const decisionValid = (v: unknown): v is ProductionDecision =>
  eventValid(v) &&
  object(v) &&
  ['model', 'style', 'other'].includes(v.category as string) &&
  typeof v.subject === 'string' &&
  typeof v.value === 'string' &&
  typeof v.note === 'string'
const ordered = <T extends { at: number; id: string }>(a: T, b: T) =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 子 Map 在创建／迁移时一并建立，首次协作追加也不会竞争替换整份 history。 */
export function createProductionMap(record?: ProductionRecord): Y.Map<unknown> {
  const snapshot = record ? clone(record) : undefined
  const map = new Y.Map<unknown>()
  map.set('selection', new Y.Map(Object.entries(snapshot?.selection ?? {})))
  map.set(
    'confirmations',
    new Y.Map(
      (snapshot?.confirmations ?? []).filter(confirmationValid).map((v) => [v.id, clone(v)]),
    ),
  )
  map.set(
    'decisions',
    new Y.Map((snapshot?.decisions ?? []).filter(decisionValid).map((v) => [v.id, clone(v)])),
  )
  map.set('goals', createProductionGoals(snapshot?.goals))
  map.set('sourceMap', createSourceMap(snapshot?.sourceMap))
  map.set('continuity', createContinuityMap(snapshot?.continuity))
  return map
}

/** 只取现有生产 Map，不隐式创建或写入；供后续独立制作元数据扩展。 */
export function productionMapOf(doc: PleinDoc, boardId: string): Y.Map<unknown> | undefined {
  const value = doc.elementMaps.get(boardId)?.get('production')
  return value instanceof Y.Map ? value : undefined
}
export function readProduction(value: unknown): ProductionRecord | undefined {
  if (!(value instanceof Y.Map)) return undefined
  const selection = value.get('selection')
  const pick = selection instanceof Y.Map ? selection.toJSON() : {}
  const confirmations = value.get('confirmations')
  const decisions = value.get('decisions')
  const goals = readProductionGoals(value.get('goals'))
  const sourceMap = readSourceMap(value.get('sourceMap'))
  const continuity = readContinuity(value.get('continuity'))
  // Public reads are immutable value snapshots, including unknown JSON fields
  // inside valid history records. Never freeze the actual Y.Map stored objects.
  return freeze(
    clone({
      ...(goals.length ? { goals } : {}),
      ...(sourceMap && (sourceMap.sources.length || sourceMap.proposals.length)
        ? { sourceMap }
        : {}),
      ...(continuity &&
      (continuity.subjects.length || continuity.plans.length || continuity.observations.length)
        ? { continuity }
        : {}),
      selection: {
        ...(typeof pick.trialShotId === 'string' ? { trialShotId: pick.trialShotId } : {}),
        ...(typeof pick.sequenceId === 'string' ? { sequenceId: pick.sequenceId } : {}),
      },
      confirmations:
        confirmations instanceof Y.Map
          ? [...confirmations.values()].filter(confirmationValid).sort(ordered)
          : [],
      decisions:
        decisions instanceof Y.Map
          ? [...decisions.values()].filter(decisionValid).sort(ordered)
          : [],
    }),
  )
}

/** 内容扩展在这里组成快照；查看偏好、任务状态和生成结果不属于分镜内容。 */
export function productionContentSnapshot(board: CanvasElement | undefined): string | undefined {
  const shots = board?.params?.shots
  if (board?.nodeType !== 'plein/storyboard' || !Array.isArray(shots) || !shots.length)
    return undefined
  const ids = shots.map((shot: unknown) => (object(shot) ? shot.id : undefined))
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
    return undefined
  const sourceMap = sourceMapContentSnapshot(board.production?.sourceMap)
  const continuity = continuityContentSnapshot(
    board.production?.continuity,
    new Set(ids as string[]),
  )
  // 没有来源数据时保留旧快照格式；首次固定原文后旧内容确认自然过期。
  return JSON.stringify(
    continuity === undefined
      ? sourceMap === undefined
        ? shots
        : { shots, sourceMap }
      : { shots, ...(sourceMap === undefined ? {} : { sourceMap }), continuity },
    (_key, value: unknown) =>
      object(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value,
  )
}
const sameScope = (a: ProductionScope, b: ProductionScope) =>
  a.canvasId === b.canvasId && a.boardId === b.boardId
export function currentProductionConfirmation(
  board: CanvasElement | undefined,
  canvasId: string,
): ProductionConfirmation | undefined {
  const snapshot = productionContentSnapshot(board)
  if (!board || !snapshot) return undefined
  return board.production?.confirmations
    .filter(
      (record) =>
        !record.historical &&
        sameScope(record.scope, { canvasId, boardId: board.id }) &&
        record.snapshot === snapshot,
    )
    .at(-1)
}
export function currentProductionDecisions(
  board: CanvasElement | undefined,
  canvasId: string,
): ProductionDecision[] {
  if (!board) return []
  const latest = new Map<string, ProductionDecision>()
  for (const record of board.production?.decisions ?? []) {
    if (!record.historical && sameScope(record.scope, { canvasId, boardId: board.id }))
      latest.set(JSON.stringify([record.category, record.subject]), record)
  }
  return [...latest.values()]
}

function mutate(doc: PleinDoc, boardId: string, fn: (map: Y.Map<unknown>) => void): boolean {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (doc.get(boardId)?.nodeType !== 'plein/storyboard') return false
  const map = productionMapOf(doc, boardId)
  if (
    !map ||
    !['selection', 'confirmations', 'decisions'].every((key) => map.get(key) instanceof Y.Map)
  )
    return false
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    doc.mutable(boardId)
    fn(map)
  }, doc.origin)
  doc.undo.stopCapturing()
  return true
}
export function selectProductionTarget(
  doc: PleinDoc,
  boardId: string,
  selection: ProductionSelection,
): boolean {
  return mutate(doc, boardId, (map) => {
    const target = map.get('selection') as Y.Map<unknown>
    for (const key of ['trialShotId', 'sequenceId'] as const) {
      if (key in selection) {
        if (selection[key] === undefined) target.delete(key)
        else target.set(key, clone(selection[key]))
      }
    }
  })
}
/** 同端连续操作即使同毫秒也保持追加顺序；跨端同时间由 ID 确定。 */
function nextEventTime(doc: PleinDoc, boardId: string): number {
  const record = doc.get(boardId)?.production
  let at = Date.now()
  for (const event of [...(record?.confirmations ?? []), ...(record?.decisions ?? [])])
    at = Math.max(at, event.at + 1)
  return at
}
/** 只能由实际 UI 操作调用；通用 ElementPatch / Agent capability 不提供此写入口。 */
export function confirmProductionContent(
  doc: PleinDoc,
  input: { scope: ProductionScope; expectedSnapshot: string; version: string; userId: string },
): boolean {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (
    !scopeValid(input.scope) ||
    !input.userId.trim() ||
    productionContentSnapshot(doc.get(input.scope.boardId)) !== input.expectedSnapshot
  )
    return false
  const record: ProductionConfirmation = {
    id: `confirmation-${newId('el')}`,
    scope: { ...input.scope },
    snapshot: input.expectedSnapshot,
    version: input.version,
    actor: { userId: input.userId, source: 'ui' },
    at: nextEventTime(doc, input.scope.boardId),
  }
  return mutate(doc, input.scope.boardId, (map) =>
    (map.get('confirmations') as Y.Map<ProductionConfirmation>).set(record.id, clone(record)),
  )
}
export function appendProductionDecision(
  doc: PleinDoc,
  input: {
    scope: ProductionScope
    userId: string
    category: ProductionDecision['category']
    subject: string
    value: string
    note?: string
  },
): boolean {
  const record: ProductionDecision = {
    id: `decision-${newId('el')}`,
    scope: { ...input.scope },
    category: input.category,
    subject: input.subject.trim().slice(0, 120),
    value: input.value.trim().slice(0, 2000),
    note: (input.note ?? '').trim().slice(0, 2000),
    actor: { userId: input.userId, source: 'ui' },
    at: nextEventTime(doc, input.scope.boardId),
  }
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (!decisionValid(record) || !record.subject || !record.value) return false
  return mutate(doc, input.scope.boardId, (map) =>
    (map.get('decisions') as Y.Map<ProductionDecision>).set(record.id, clone(record)),
  )
}

/** 副本可继续选择原镜头；只重映射确实复制的序列，全部原确认与决策保留为历史。 */
export function copyProduction(
  record: ProductionRecord,
  ids: ReadonlyMap<string, string>,
  canvasId?: string,
): ProductionRecord {
  return {
    ...(record.goals?.length ? { goals: copyProductionGoals(record.goals, ids, canvasId) } : {}),
    ...(record.sourceMap ? { sourceMap: copySourceMap(record.sourceMap, ids) } : {}),
    ...(record.continuity ? { continuity: copyContinuity(record.continuity, ids) } : {}),
    selection: {
      ...(record.selection?.trialShotId ? { trialShotId: record.selection.trialShotId } : {}),
      ...(record.selection?.sequenceId && ids.has(record.selection.sequenceId)
        ? { sequenceId: ids.get(record.selection.sequenceId)! }
        : {}),
    },
    confirmations: record.confirmations.map((r) => ({ ...clone(r), historical: true })),
    decisions: record.decisions.map((r) => ({ ...clone(r), historical: true })),
  }
}

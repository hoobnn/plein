import * as Y from 'yjs'
import { ReadOnlyDocError } from './commands'
import type { PleinDoc } from './doc'
import { newId } from './ids'
import type { ProductionActor, ProductionScope } from './production'
import type { CanvasElement } from './types'

export type ProductionRequirement = 'unspecified' | 'required' | 'none'
export interface ProductionGoal {
  aspectRatio?: '9:16' | '16:9'
  resolution?: '720p' | '1080p'
  duration?: { min?: number; max?: number }
  dialogue: ProductionRequirement
  originalAudio: ProductionRequirement
  music: ProductionRequirement
  sfx: ProductionRequirement
  subtitles: ProductionRequirement
  /** 技术例外是明确目标；自由文字不能被自动解释成通过。 */
  allowSilence: boolean
  allowBlack: boolean
  requirements: string
}
export interface ProductionGoalScope extends ProductionScope {
  sequenceId?: string
}
export interface ProductionGoalRevision {
  id: string
  scope: ProductionGoalScope
  parents: string[]
  content: ProductionGoal
  snapshot: string
  actor: ProductionActor
  at: number
  historical?: boolean
  origin?: { id: string; scope: ProductionGoalScope }
}
export const emptyProductionGoal = (): ProductionGoal => ({
  dialogue: 'unspecified',
  originalAudio: 'unspecified',
  music: 'unspecified',
  sfx: 'unspecified',
  subtitles: 'unspecified',
  allowSilence: false,
  allowBlack: false,
  requirements: '',
})
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const id = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const scopeValid = (v: unknown): v is ProductionGoalScope =>
  object(v) && id(v.canvasId) && id(v.boardId) && (v.sequenceId === undefined || id(v.sequenceId))
export const sameProductionGoalScope = (a: ProductionGoalScope, b: ProductionGoalScope) =>
  a.canvasId === b.canvasId && a.boardId === b.boardId && a.sequenceId === b.sequenceId
const requirements = ['dialogue', 'originalAudio', 'music', 'sfx', 'subtitles'] as const
export function isProductionGoal(v: unknown): v is ProductionGoal {
  if (!object(v)) return false
  if (v.aspectRatio !== undefined && !['9:16', '16:9'].includes(v.aspectRatio as string))
    return false
  if (v.resolution !== undefined && !['720p', '1080p'].includes(v.resolution as string))
    return false
  if (!requirements.every((key) => ['unspecified', 'required', 'none'].includes(v[key] as string)))
    return false
  if (
    typeof v.allowSilence !== 'boolean' ||
    typeof v.allowBlack !== 'boolean' ||
    typeof v.requirements !== 'string' ||
    v.requirements.length > 4000
  )
    return false
  if (v.duration !== undefined) {
    if (!object(v.duration)) return false
    const { min, max } = v.duration
    if (
      ![min, max].every(
        (n) =>
          n === undefined || (typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 86400),
      )
    )
      return false
    if (typeof min === 'number' && typeof max === 'number' && min > max) return false
  }
  return true
}
/** 显式列出字段，额外属性和执行信息不能进入目标快照。 */
export function productionGoalSnapshot(goal: ProductionGoal): string {
  return JSON.stringify({
    ...(goal.aspectRatio ? { aspectRatio: goal.aspectRatio } : {}),
    ...(goal.resolution ? { resolution: goal.resolution } : {}),
    ...(goal.duration && (goal.duration.min !== undefined || goal.duration.max !== undefined)
      ? {
          duration: {
            ...(goal.duration.min !== undefined ? { min: goal.duration.min } : {}),
            ...(goal.duration.max !== undefined ? { max: goal.duration.max } : {}),
          },
        }
      : {}),
    ...Object.fromEntries(requirements.map((key) => [key, goal[key]])),
    allowSilence: goal.allowSilence,
    allowBlack: goal.allowBlack,
    requirements: goal.requirements,
  })
}
export function isProductionGoalRevision(v: unknown): v is ProductionGoalRevision {
  return (
    object(v) &&
    id(v.id) &&
    scopeValid(v.scope) &&
    Array.isArray(v.parents) &&
    v.parents.every(id) &&
    !v.parents.includes(v.id) &&
    new Set(v.parents).size === v.parents.length &&
    isProductionGoal(v.content) &&
    v.snapshot === productionGoalSnapshot(v.content) &&
    object(v.actor) &&
    v.actor.source === 'ui' &&
    id(v.actor.userId) &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at) &&
    (v.historical === undefined || typeof v.historical === 'boolean') &&
    (v.origin === undefined || (object(v.origin) && id(v.origin.id) && scopeValid(v.origin.scope)))
  )
}
export function readProductionGoals(value: unknown): ProductionGoalRevision[] {
  return freeze(
    value instanceof Y.Map
      ? [...value.entries()]
          .filter(([key, v]) => isProductionGoalRevision(v) && key === v.id)
          .map(([, v]) => clone(v as ProductionGoalRevision))
          .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      : [],
  )
}
export function createProductionGoals(goals: ProductionGoalRevision[] = []): Y.Map<unknown> {
  return new Y.Map(goals.filter(isProductionGoalRevision).map((r) => [r.id, clone(r)]))
}
/** 并发完整修订保留为多个 head，不能悄悄拼成从未有人保存过的混合目标。 */
export function productionGoalHeads(
  board: CanvasElement | undefined,
  scope: ProductionGoalScope,
): ProductionGoalRevision[] {
  if (board?.id !== scope.boardId || board.nodeType !== 'plein/storyboard') return []
  const records = (board.production?.goals ?? []).filter(
    (r) => !r.historical && sameProductionGoalScope(r.scope, scope),
  )
  const superseded = new Set(records.flatMap((r) => r.parents))
  return records.filter((r) => !superseded.has(r.id))
}
export function appendProductionGoal(
  doc: PleinDoc,
  input: {
    scope: ProductionGoalScope
    content: ProductionGoal
    expectedHeads: string[]
    userId: string
  },
): ProductionGoalRevision | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (!scopeValid(input.scope)) return undefined
  const board = doc.get(input.scope.boardId)
  if (
    !scopeValid(input.scope) ||
    !id(input.userId) ||
    !isProductionGoal(input.content) ||
    board?.nodeType !== 'plein/storyboard' ||
    (input.scope.sequenceId && doc.get(input.scope.sequenceId)?.nodeType !== 'plein/sequence')
  )
    return undefined
  const heads = productionGoalHeads(board, input.scope)
  if (
    JSON.stringify(heads.map((r) => r.id).sort()) !==
    JSON.stringify([...input.expectedHeads].sort())
  )
    return undefined
  const production = doc.elementMaps.get(board.id)?.get('production')
  const map = production instanceof Y.Map ? production.get('goals') : undefined
  if (!(map instanceof Y.Map)) return undefined
  const snapshot = productionGoalSnapshot(input.content)
  const record: ProductionGoalRevision = {
    id: `goal-${newId('el')}`,
    scope: { ...input.scope },
    parents: heads.map((r) => r.id),
    content: JSON.parse(snapshot) as ProductionGoal,
    snapshot,
    actor: { userId: input.userId, source: 'ui' },
    at: Math.max(Date.now(), ...heads.map((r) => r.at + 1)),
  }
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    doc.mutable(board.id)
    map.set(record.id, record)
  }, doc.origin)
  doc.undo.stopCapturing()
  return clone(record)
}

/** 目标是制作要求，不是人工确认；内部身份明确重映射，外部序列只保留历史。 */
export function copyProductionGoals(
  goals: ProductionGoalRevision[],
  ids: ReadonlyMap<string, string>,
  canvasId?: string,
): ProductionGoalRevision[] {
  const revisions = new Map(goals.map((r) => [r.id, `goal-${newId('el')}`]))
  return goals.map((r) => ({
    ...clone(r),
    id: revisions.get(r.id)!,
    parents: r.parents.map((p) => revisions.get(p) ?? p),
    scope: {
      canvasId: canvasId ?? r.scope.canvasId,
      boardId: ids.get(r.scope.boardId) ?? r.scope.boardId,
      ...(r.scope.sequenceId
        ? { sequenceId: ids.get(r.scope.sequenceId) ?? r.scope.sequenceId }
        : {}),
    },
    origin: r.origin ?? { id: r.id, scope: { ...r.scope } },
    historical:
      r.historical ||
      !canvasId ||
      !ids.has(r.scope.boardId) ||
      (!!r.scope.sequenceId && !ids.has(r.scope.sequenceId)),
  }))
}
/** 包迁移只处理类型化范围，不改自由文字；原始来源保留。 */
export function remapProductionGoalScopes(
  goals: ProductionGoalRevision[],
  ids: ReadonlyMap<string, string>,
): ProductionGoalRevision[] {
  const changed = goals.some((r) =>
    [r.scope.canvasId, r.scope.boardId, r.scope.sequenceId].some(
      (v) => v && ids.has(v) && ids.get(v) !== v,
    ),
  )
  if (!changed) return goals
  const revisionIds = new Map(goals.map((r) => [r.id, `goal-${newId('el')}`]))
  return goals.map((r) => ({
    ...clone(r),
    id: revisionIds.get(r.id)!,
    parents: r.parents.map((p) => revisionIds.get(p) ?? p),
    scope: {
      canvasId: ids.get(r.scope.canvasId) ?? r.scope.canvasId,
      boardId: ids.get(r.scope.boardId) ?? r.scope.boardId,
      ...(r.scope.sequenceId
        ? { sequenceId: ids.get(r.scope.sequenceId) ?? r.scope.sequenceId }
        : {}),
    },
    origin: r.origin ?? { id: r.id, scope: { ...r.scope } },
  }))
}

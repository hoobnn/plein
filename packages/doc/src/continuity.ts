import * as Y from 'yjs'
import { ReadOnlyDocError } from './commands'
import type { PleinDoc } from './doc'
import { newId } from './ids'
import { creativeReviewTarget } from './reviews'
import { sameCreativeReviewTarget, type CreativeReviewTarget } from './review-types'
import type { ProductionScope } from './production'

export interface ContinuitySubject {
  id: string
  kind: 'character' | 'scene' | 'prop'
  label: string
  binding: { elementId?: string; libraryId?: string } | null
  originAtCapture: ProductionScope
}
export interface EntityState {
  worldPosition?: string
  screenPosition?: string
  pose?: string
  holder?: { subjectId: string; hand: 'left' | 'right' | 'both' }
  condition?: string
}
export type StateField = keyof EntityState
export const STATE_FIELDS = [
  'worldPosition',
  'screenPosition',
  'pose',
  'holder',
  'condition',
] as const
export interface StateInheritance {
  fromShotId: string
  planRevisionId: string
  subjectId: string
  fields: StateField[]
}
export interface ShotPlanContent {
  intent?: string
  start: Record<string, EntityState>
  end: Record<string, EntityState>
  inherits: StateInheritance[]
  reset?: { kind: 'time_jump' | 'new_scene' | 'flashback'; reason: string }
}
export interface ShotPlanRevision {
  id: string
  shotId: string
  parents: string[]
  content: ShotPlanContent
  userId: string
  at: number
  originAtCapture: ProductionScope
}
export type ObservedValue =
  | {
      certainty: 'observed' | 'inferred'
      value: string | NonNullable<EntityState['holder']>
      note?: string
    }
  | { certainty: 'unknown'; note: string }
export type ObservationEvidence =
  | {
      kind: 'frame'
      position: 'start' | 'end' | { at: number }
      frameAssetId: string
      aspects: ['visual']
    }
  | {
      kind: 'interval'
      start: number
      end: number
      duration: number
      aspects: Array<'visual' | 'motion' | 'sound'>
      playback: { completed: true; audible: boolean }
      declared: true
    }
export interface ContinuityObservation {
  id: string
  scope: ProductionScope
  shotId: string
  phase: 'start' | 'end'
  nodeId: string | null
  originNodeId?: string
  port?: string
  target: CreativeReviewTarget
  evidence: ObservationEvidence
  states: Record<string, Partial<Record<StateField, ObservedValue>>>
  basisPlanRevisionId?: string
  origin: { kind: 'manual'; userId: string } | { kind: 'tool'; nodeId: string; resultId: string }
  at: number
  historical?: boolean
}
export interface ContinuityRecord {
  subjects: ContinuitySubject[]
  plans: ShotPlanRevision[]
  observations: ContinuityObservation[]
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const assetId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const scope = (v: unknown): v is ProductionScope => object(v) && str(v.canvasId) && str(v.boardId)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const ordered = <T extends { id: string; at: number }>(a: T, b: T) =>
  a.at - b.at || a.id.localeCompare(b.id)
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!object(a) || !object(b)) return JSON.stringify(a) === JSON.stringify(b)
  const ka = Object.keys(a).sort(),
    kb = Object.keys(b).sort()
  return JSON.stringify(ka) === JSON.stringify(kb) && ka.every((key) => equal(a[key], b[key]))
}
const targetValid = (v: unknown): v is CreativeReviewTarget =>
  object(v) &&
  ['image', 'video', 'audio'].includes(v.kind as string) &&
  assetId(v.assetId) &&
  (v.resultId === undefined || str(v.resultId))
const holder = (v: unknown) =>
  object(v) && str(v.subjectId) && ['left', 'right', 'both'].includes(v.hand as string)
const entityStateValid = (v: unknown): v is EntityState =>
  object(v) &&
  Object.entries(v).every(
    ([key, value]) =>
      STATE_FIELDS.includes(key as StateField) &&
      (key === 'holder' ? holder(value) : typeof value === 'string' && value.length <= 2000),
  )
const stateMapValid = (v: unknown) => object(v) && Object.values(v).every(entityStateValid)
const contentValid = (v: unknown): v is ShotPlanContent =>
  object(v) &&
  (v.intent === undefined || (typeof v.intent === 'string' && v.intent.length <= 2000)) &&
  stateMapValid(v.start) &&
  stateMapValid(v.end) &&
  Array.isArray(v.inherits) &&
  v.inherits.every(
    (r) =>
      object(r) &&
      str(r.fromShotId) &&
      str(r.planRevisionId) &&
      str(r.subjectId) &&
      Array.isArray(r.fields) &&
      r.fields.length > 0 &&
      new Set(r.fields).size === r.fields.length &&
      r.fields.every((f) => STATE_FIELDS.includes(f)),
  ) &&
  (v.reset === undefined ||
    (object(v.reset) &&
      ['time_jump', 'new_scene', 'flashback'].includes(v.reset.kind as string) &&
      str(v.reset.reason) &&
      !v.inherits.length))
const subjectValid = (v: unknown): v is ContinuitySubject =>
  object(v) &&
  str(v.id) &&
  ['character', 'scene', 'prop'].includes(v.kind as string) &&
  str(v.label) &&
  scope(v.originAtCapture) &&
  (v.binding === null ||
    (object(v.binding) && (str(v.binding.elementId) || str(v.binding.libraryId))))
const planValid = (v: unknown): v is ShotPlanRevision =>
  object(v) &&
  str(v.id) &&
  str(v.shotId) &&
  Array.isArray(v.parents) &&
  v.parents.every(str) &&
  contentValid(v.content) &&
  str(v.userId) &&
  Number.isFinite(v.at) &&
  scope(v.originAtCapture)
function evidenceValid(v: unknown, kind: CreativeReviewTarget['kind']): v is ObservationEvidence {
  if (
    !object(v) ||
    !Array.isArray(v.aspects) ||
    !v.aspects.length ||
    new Set(v.aspects).size !== v.aspects.length
  )
    return false
  if (v.kind === 'frame')
    return (
      kind !== 'audio' &&
      assetId(v.frameAssetId) &&
      v.aspects.length === 1 &&
      v.aspects[0] === 'visual' &&
      (v.position === 'start' ||
        v.position === 'end' ||
        (object(v.position) &&
          typeof v.position.at === 'number' &&
          Number.isFinite(v.position.at) &&
          v.position.at >= 0))
    )
  return (
    v.kind === 'interval' &&
    kind !== 'image' &&
    typeof v.start === 'number' &&
    typeof v.end === 'number' &&
    typeof v.duration === 'number' &&
    [v.start, v.end, v.duration].every(Number.isFinite) &&
    v.start >= 0 &&
    v.end > v.start &&
    v.end <= v.duration &&
    v.declared === true &&
    object(v.playback) &&
    v.playback.completed === true &&
    typeof v.playback.audible === 'boolean' &&
    v.aspects.every((a) => ['visual', 'motion', 'sound'].includes(a)) &&
    (kind !== 'audio' || v.aspects.every((a) => a === 'sound')) &&
    (!v.aspects.includes('sound') || v.playback.audible)
  )
}
const observedValid = (v: unknown, field: string): v is ObservedValue =>
  object(v) &&
  (v.certainty === 'unknown'
    ? !('value' in v) && typeof v.note === 'string'
    : ['observed', 'inferred'].includes(v.certainty as string) &&
      (field === 'holder' ? holder(v.value) : typeof v.value === 'string') &&
      (v.note === undefined || typeof v.note === 'string'))
function knownObservedStates(
  record: ContinuityRecord,
  states: ContinuityObservation['states'],
): boolean {
  return Object.entries(states).every(
    ([id, fields]) =>
      record.subjects.some((s) => s.id === id) &&
      Object.entries(fields).every(([field, value]) => {
        if (field !== 'holder' || value?.certainty === 'unknown') return true
        const held = value?.value
        return (
          object(held) &&
          record.subjects.some((s) => s.id === id && s.kind === 'prop') &&
          record.subjects.some((s) => s.id === held.subjectId && s.kind === 'character')
        )
      }),
  )
}
const observationValid = (v: unknown): v is ContinuityObservation =>
  object(v) &&
  str(v.id) &&
  scope(v.scope) &&
  str(v.shotId) &&
  ['start', 'end'].includes(v.phase as string) &&
  (v.nodeId === null || str(v.nodeId)) &&
  (v.originNodeId === undefined || str(v.originNodeId)) &&
  (v.basisPlanRevisionId === undefined || str(v.basisPlanRevisionId)) &&
  (v.port === undefined || str(v.port)) &&
  targetValid(v.target) &&
  evidenceValid(v.evidence, v.target.kind) &&
  object(v.states) &&
  Object.values(v.states).every(
    (state) =>
      object(state) &&
      Object.entries(state).every(
        ([field, value]) =>
          STATE_FIELDS.includes(field as StateField) && observedValid(value, field),
      ),
  ) &&
  object(v.origin) &&
  ((v.origin.kind === 'manual' && str(v.origin.userId)) ||
    (v.origin.kind === 'tool' &&
      str(v.origin.nodeId) &&
      str(v.origin.resultId) &&
      Object.values(v.states).every((state) =>
        Object.values(state as object).every(
          (value) => (value as ObservedValue).certainty !== 'observed',
        ),
      ))) &&
  Number.isFinite(v.at) &&
  (v.historical === undefined || typeof v.historical === 'boolean')
const valid = { subjects: subjectValid, plans: planValid, observations: observationValid }
type Part = keyof ContinuityRecord
export const emptyContinuity = (): ContinuityRecord => ({
  subjects: [],
  plans: [],
  observations: [],
})
export function createContinuityMap(record?: ContinuityRecord): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  for (const key of ['subjects', 'plans', 'observations'] as const)
    map.set(
      key,
      new Y.Map(
        (record?.[key] ?? [])
          .filter(valid[key] as (v: unknown) => boolean)
          .map((v) => [v.id, clone(v)]),
      ),
    )
  return map
}
export function readContinuity(value: unknown): ContinuityRecord | undefined {
  if (!(value instanceof Y.Map)) return undefined
  const out = emptyContinuity()
  for (const key of ['subjects', 'plans', 'observations'] as const) {
    const part = value.get(key)
    if (part instanceof Y.Map)
      (out[key] as unknown[]) = [...part.values()]
        .filter(valid[key] as (v: unknown) => boolean)
        .map(clone)
        .sort((a, b) => (a as { id: string }).id.localeCompare((b as { id: string }).id))
  }
  return out
}
export function continuityOf(doc: PleinDoc, boardId: string): ContinuityRecord {
  const production = doc.elementMaps.get(boardId)?.get('production')
  return (
    readContinuity(production instanceof Y.Map ? production.get('continuity') : undefined) ??
    emptyContinuity()
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
  const map = production instanceof Y.Map ? production.get('continuity') : undefined
  if (!(map instanceof Y.Map) || !Object.keys(valid).every((key) => map.get(key) instanceof Y.Map))
    return false
  doc.undo.stopCapturing()
  doc.ydoc.transact(() => {
    doc.mutable(boardId)
    fn((key) => map.get(key) as Y.Map<unknown>)
  }, doc.origin)
  doc.undo.stopCapturing()
  return true
}
function hasShot(doc: PleinDoc, boardId: string, shotId: string): boolean {
  const shots = doc.get(boardId)?.params?.shots
  return Array.isArray(shots) && shots.some((shot: unknown) => object(shot) && shot.id === shotId)
}
export function registerContinuitySubject(
  doc: PleinDoc,
  input: {
    scope: ProductionScope
    kind: ContinuitySubject['kind']
    label: string
    binding?: ContinuitySubject['binding']
  },
): string | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const subject: ContinuitySubject = {
    id: `subject-${newId('el')}`,
    kind: input.kind,
    label: input.label.trim().slice(0, 120),
    binding: input.binding ? clone(input.binding) : null,
    originAtCapture: { ...input.scope },
  }
  if (!subjectValid(subject) || (subject.binding?.elementId && !doc.get(subject.binding.elementId)))
    return undefined
  return mutate(doc, input.scope.boardId, (part) => part('subjects').set(subject.id, subject))
    ? subject.id
    : undefined
}
export const emptyShotPlan = (): ShotPlanContent => ({ start: {}, end: {}, inherits: [] })
export function shotPlanHeads(record: ContinuityRecord, shotId: string): ShotPlanRevision[] {
  const plans = record.plans.filter((p) => p.shotId === shotId)
  const parents = new Set(plans.flatMap((p) => p.parents))
  return plans.filter((p) => !parents.has(p.id)).sort(ordered)
}
export function currentShotPlan(record: ContinuityRecord, shotId: string) {
  const heads = shotPlanHeads(record, shotId)
  return {
    state:
      heads.length === 0
        ? ('none' as const)
        : heads.length === 1
          ? ('current' as const)
          : ('conflict' as const),
    heads,
    plan: heads.length === 1 ? heads[0] : undefined,
  }
}
function knownStates(record: ContinuityRecord, states: Record<string, EntityState>): boolean {
  return Object.entries(states).every(
    ([id, state]) =>
      record.subjects.some((s) => s.id === id) &&
      (!state.holder ||
        (record.subjects.some((s) => s.id === id && s.kind === 'prop') &&
          record.subjects.some((s) => s.id === state.holder!.subjectId && s.kind === 'character'))),
  )
}
export function appendShotPlan(
  doc: PleinDoc,
  input: {
    scope: ProductionScope
    shotId: string
    expectedHeads: string[]
    content: ShotPlanContent
    userId: string
  },
): ShotPlanRevision | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const record = continuityOf(doc, input.scope.boardId)
  const heads = shotPlanHeads(record, input.shotId)
    .map((p) => p.id)
    .sort()
  if (
    !scope(input.scope) ||
    !input.userId.trim() ||
    !hasShot(doc, input.scope.boardId, input.shotId) ||
    !equal(heads, [...new Set(input.expectedHeads)].sort()) ||
    !contentValid(input.content) ||
    !knownStates(record, input.content.start) ||
    !knownStates(record, input.content.end)
  )
    return undefined
  const linked = new Set<string>()
  for (const ref of input.content.inherits) {
    const source = record.plans.find(
      (p) => p.id === ref.planRevisionId && p.shotId === ref.fromShotId,
    )
    if (
      !source ||
      source.shotId === input.shotId ||
      !hasShot(doc, input.scope.boardId, source.shotId) ||
      !record.subjects.some((s) => s.id === ref.subjectId)
    )
      return undefined
    for (const field of ref.fields) {
      const key = JSON.stringify([ref.subjectId, field])
      if (
        linked.has(key) ||
        input.content.start[ref.subjectId]?.[field] !== undefined ||
        source.content.end[ref.subjectId]?.[field] === undefined ||
        !knownStates(record, {
          [ref.subjectId]: { [field]: source.content.end[ref.subjectId]?.[field] },
        })
      )
        return undefined
      linked.add(key)
    }
  }
  const content = clone(input.content)
  const previous = heads.length === 1 ? record.plans.find((p) => p.id === heads[0]) : undefined
  if (previous && equal(previous.content, content)) return clone(previous)
  const revision: ShotPlanRevision = {
    id: `plan-${newId('el')}`,
    shotId: input.shotId,
    parents: heads,
    content,
    userId: input.userId,
    at: Date.now(),
    originAtCapture: { ...input.scope },
  }
  return mutate(doc, input.scope.boardId, (part) => part('plans').set(revision.id, revision))
    ? clone(revision)
    : undefined
}
/** P07 修改镜头目的时保留全部起止状态，迟到编辑不能覆盖另一端的修订。 */
export function updateShotIntent(
  doc: PleinDoc,
  input: {
    scope: ProductionScope
    shotId: string
    expectedHeads: string[]
    intent: string
    userId: string
  },
): ShotPlanRevision | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  const current = currentShotPlan(continuityOf(doc, input.scope.boardId), input.shotId)
  if (current.state === 'conflict') return undefined
  return appendShotPlan(doc, {
    ...input,
    content: { ...(current.plan?.content ?? emptyShotPlan()), intent: input.intent },
  })
}
export function resolvedShotState(record: ContinuityRecord, plan: ShotPlanRevision) {
  const start = clone(plan.content.start),
    end = clone(plan.content.end)
  const missing: StateInheritance[] = []
  for (const ref of plan.content.inherits) {
    const from = record.plans.find(
      (p) => p.id === ref.planRevisionId && p.shotId === ref.fromShotId,
    )
    for (const field of ref.fields) {
      const value = from?.content.end[ref.subjectId]?.[field]
      if (value === undefined || !knownStates(record, { [ref.subjectId]: { [field]: value } })) {
        missing.push(ref)
        continue
      }
      start[ref.subjectId] ??= {}
      Object.assign(start[ref.subjectId]!, { [field]: clone(value) })
    }
  }
  return { start, end, missing }
}
export function continuityDependencies(
  record: ContinuityRecord,
  shotId: string,
  activeShotIds?: ReadonlySet<string>,
) {
  return shotPlanHeads(record, shotId).flatMap((plan) =>
    plan.content.inherits.map((ref) => {
      const original = record.plans.find(
        (p) => p.id === ref.planRevisionId && p.shotId === ref.fromShotId,
      )
      const heads = shotPlanHeads(record, ref.fromShotId)
      const changedFields = ref.fields.filter(
        (field) =>
          !original ||
          !heads.length ||
          heads.some(
            (p) =>
              !equal(
                p.content.end[ref.subjectId]?.[field],
                original.content.end[ref.subjectId]?.[field],
              ),
          ),
      )
      const ambiguous = ref.fields.some((field) =>
        heads.some(
          (p) =>
            !equal(
              p.content.end[ref.subjectId]?.[field],
              heads[0]?.content.end[ref.subjectId]?.[field],
            ),
        ),
      )
      const identitiesKnown =
        !!original &&
        ref.fields.every((field) => original.content.end[ref.subjectId]?.[field] !== undefined) &&
        knownStates(record, {
          [ref.subjectId]: Object.fromEntries(
            ref.fields.map((field) => [field, original.content.end[ref.subjectId]?.[field]]),
          ),
        })
      return {
        ...clone(ref),
        toShotId: shotId,
        toPlanRevisionId: plan.id,
        changedFields,
        status:
          !original ||
          !heads.length ||
          !identitiesKnown ||
          (activeShotIds && !activeShotIds.has(ref.fromShotId))
            ? ('missing' as const)
            : ambiguous
              ? ('conflict' as const)
              : changedFields.length
                ? ('changed' as const)
                : ('current' as const),
      }
    }),
  )
}
export function continuityDependents(
  record: ContinuityRecord,
  fromShotId: string,
  activeShotIds?: ReadonlySet<string>,
) {
  return [...new Set(record.plans.map((p) => p.shotId))]
    .filter((id) => !activeShotIds || activeShotIds.has(id))
    .flatMap((shotId) => continuityDependencies(record, shotId, activeShotIds))
    .filter((ref) => ref.fromShotId === fromShotId)
}
export function recordContinuityObservation(
  doc: PleinDoc,
  input: Omit<ContinuityObservation, 'id' | 'at' | 'historical' | 'originNodeId'>,
): string | undefined {
  if (doc.readOnly) throw new ReadOnlyDocError()
  if (!scope(input.scope)) return undefined
  const node = input.nodeId ? doc.get(input.nodeId) : undefined
  const source = node?.params?.source
  const record = continuityOf(doc, input.scope.boardId)
  if (
    !scope(input.scope) ||
    !hasShot(doc, input.scope.boardId, input.shotId) ||
    !node ||
    !object(source) ||
    source.storyboard !== input.scope.boardId ||
    source.shot !== input.shotId ||
    !sameCreativeReviewTarget(creativeReviewTarget(node, input.port), input.target) ||
    !knownObservedStates(record, input.states) ||
    (input.basisPlanRevisionId &&
      !record.plans.some((p) => p.id === input.basisPlanRevisionId && p.shotId === input.shotId))
  )
    return undefined
  const origin = input.origin
  if (
    origin.kind === 'tool' &&
    !doc.get(origin.nodeId)?.results?.some((r) => r.id === origin.resultId)
  )
    return undefined
  const observation: ContinuityObservation = {
    ...clone(input),
    originNodeId: node.id,
    id: `observation-${newId('el')}`,
    at: Date.now(),
  }
  if (!observationValid(observation)) return undefined
  return mutate(doc, input.scope.boardId, (part) =>
    part('observations').set(observation.id, observation),
  )
    ? observation.id
    : undefined
}
export function currentContinuityObservations(
  doc: PleinDoc,
  scopeValue: ProductionScope,
  shotId: string,
  phase?: ContinuityObservation['phase'],
): ContinuityObservation[] {
  if (!hasShot(doc, scopeValue.boardId, shotId)) return []
  const record = continuityOf(doc, scopeValue.boardId)
  return record.observations
    .filter((o) => {
      const node = o.nodeId ? doc.get(o.nodeId) : undefined
      const source = node?.params?.source
      return (
        !o.historical &&
        o.scope.canvasId === scopeValue.canvasId &&
        o.scope.boardId === scopeValue.boardId &&
        o.shotId === shotId &&
        (!phase || o.phase === phase) &&
        object(source) &&
        source.storyboard === scopeValue.boardId &&
        source.shot === shotId &&
        knownObservedStates(record, o.states) &&
        sameCreativeReviewTarget(creativeReviewTarget(node, o.port), o.target)
      )
    })
    .sort(ordered)
}
export function continuityContentSnapshot(
  record?: ContinuityRecord,
  activeShotIds?: ReadonlySet<string>,
): unknown {
  if (!record?.plans.length) return undefined
  const meaningful = (p: ShotPlanRevision) =>
    !!p.content.intent?.trim() ||
    !!p.content.reset ||
    !!p.content.inherits.length ||
    [...Object.values(p.content.start), ...Object.values(p.content.end)].some((state) =>
      Object.values(state).some((v) => (typeof v === 'string' ? !!v.trim() : !!v)),
    )
  const plans = [...new Set(record.plans.map((p) => p.shotId))]
    .filter((id) => !activeShotIds || activeShotIds.has(id))
    .map((id) => shotPlanHeads(record, id))
    .filter((heads) => heads.some(meaningful))
    .flat()
  if (!plans.length) return undefined
  const ids = new Set(
    plans.flatMap((plan) => [
      ...Object.keys(plan.content.start),
      ...Object.keys(plan.content.end),
      ...plan.content.inherits.map((r) => r.subjectId),
    ]),
  )
  for (const plan of plans)
    for (const state of [...Object.values(plan.content.start), ...Object.values(plan.content.end)])
      if (state.holder) ids.add(state.holder.subjectId)
  return {
    subjects: record.subjects.filter((s) => ids.has(s.id)),
    plans: plans.map((plan) => ({ ...plan, resolved: resolvedShotState(record, plan) })),
  }
}
export function continuityAssets(record?: ContinuityRecord): string[] {
  return [
    ...new Set(
      (record?.observations ?? [])
        .flatMap((o) => [
          o.target.assetId,
          ...(o.evidence.kind === 'frame' ? [o.evidence.frameAssetId] : []),
        ])
        .filter(assetId),
    ),
  ]
}
/** 副本永远不继承观察；计划及内部身份映射后继续可编辑。 */
export function copyContinuity(
  record: ContinuityRecord,
  elementIds: ReadonlyMap<string, string>,
  libraryIds: ReadonlyMap<string, string> = new Map(),
): ContinuityRecord {
  const ids = new Map(
    [...record.subjects, ...record.plans, ...record.observations].map((v) => [
      v.id,
      `continuity-copy-${newId('el')}`,
    ]),
  )
  const state = (value: EntityState): EntityState => ({
    ...clone(value),
    ...(value.holder
      ? {
          holder: {
            ...value.holder,
            subjectId: ids.get(value.holder.subjectId) ?? value.holder.subjectId,
          },
        }
      : {}),
  })
  const states = (values: Record<string, EntityState>) =>
    Object.fromEntries(
      Object.entries(values).map(([id, value]) => [ids.get(id) ?? id, state(value)]),
    )
  return {
    subjects: record.subjects
      .map((s) => ({
        ...clone(s),
        id: ids.get(s.id)!,
        binding: s.binding
          ? {
              ...(s.binding.elementId && elementIds.has(s.binding.elementId)
                ? { elementId: elementIds.get(s.binding.elementId)! }
                : {}),
              ...(s.binding.libraryId
                ? { libraryId: libraryIds.get(s.binding.libraryId) ?? s.binding.libraryId }
                : {}),
            }
          : null,
      }))
      .map((s) => ({
        ...s,
        binding: s.binding && Object.keys(s.binding).length ? s.binding : null,
      })),
    plans: record.plans.map((p) => ({
      ...clone(p),
      id: ids.get(p.id)!,
      parents: p.parents.map((id) => ids.get(id) ?? id),
      content: {
        ...clone(p.content),
        start: states(p.content.start),
        end: states(p.content.end),
        inherits: p.content.inherits.map((r) => ({
          ...clone(r),
          planRevisionId: ids.get(r.planRevisionId) ?? r.planRevisionId,
          subjectId: ids.get(r.subjectId) ?? r.subjectId,
        })),
      },
    })),
    observations: record.observations.map((o) => ({
      ...clone(o),
      id: ids.get(o.id)!,
      nodeId: o.nodeId ? (elementIds.get(o.nodeId) ?? null) : null,
      basisPlanRevisionId: o.basisPlanRevisionId
        ? (ids.get(o.basisPlanRevisionId) ?? o.basisPlanRevisionId)
        : undefined,
      historical: true,
      states: Object.fromEntries(
        Object.entries(o.states).map(([id, fields]) => [
          ids.get(id) ?? id,
          Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key,
              key === 'holder' && value?.certainty !== 'unknown' && value && object(value.value)
                ? {
                    ...value,
                    value: {
                      ...value.value,
                      subjectId: ids.get(value.value.subjectId as string) ?? value.value.subjectId,
                    },
                  }
                : clone(value),
            ]),
          ),
        ]),
      ),
    })),
  }
}

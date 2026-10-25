import {
  isSequenceInstance,
  sequenceInstancesOf,
  videoSegmentConflict,
  type PleinDoc,
  type SequenceInstance,
} from '@plein/doc'
import { SEQUENCE_TYPE, sequenceNode } from '@plein/nodes'
import { expandedNodes, shotsOf, type ShotSource } from './storyboard'
import { activeShotNodes } from './activeShotNodes'

export interface SegmentMappingScope {
  canvasId: string
  boardId: string
  shotId: string
  sequenceId?: string
}
export interface SegmentUse {
  sequenceId: string
  clipInstanceId: string
  source: string
  narrative?: SequenceInstance['narrative']
}
export interface ShotSegmentMapping {
  sequenceId?: string
  sequenceIds: string[]
  instances: SequenceInstance[]
  users: SegmentUse[]
  problem?: string
}
const sourceOf = (doc: PleinDoc, id: string) =>
  doc.get(id)?.params?.source as ShotSource | undefined
const belongs = (scope: SegmentMappingScope, row: SequenceInstance, doc: PleinDoc) => {
  if (row.narrative)
    return (
      !row.narrative.historical &&
      row.narrative.canvasId === scope.canvasId &&
      row.narrative.boardId === scope.boardId &&
      row.narrative.shotId === scope.shotId
    )
  if (row.segment) return false
  const source = sourceOf(doc, row.source)
  return (
    source?.storyboard === scope.boardId &&
    source.shot === scope.shotId &&
    source.role === 'video' &&
    !source.detached
  )
}
export function segmentUsers(doc: PleinDoc, segmentId: string): SegmentUse[] {
  return [...doc.elements()].flatMap((sequence) =>
    sequenceInstancesOf(sequence)
      .filter((row) => row.segment?.segmentId === segmentId)
      .map((row) => ({
        sequenceId: sequence.id,
        clipInstanceId: row.clipInstanceId,
        source: row.source,
        ...(row.narrative ? { narrative: row.narrative } : {}),
      })),
  )
}
/** Current sequence binding and immutable generation origin are separate. Never infer by asset/name. */
export function shotSegmentMapping(doc: PleinDoc, scope: SegmentMappingScope): ShotSegmentMapping {
  const shots = shotsOf(doc.get(scope.boardId))
  const shotIds = new Set(shots.map((shot) => shot.id))
  if (!scope.canvasId || !shotIds.has(scope.shotId))
    return {
      sequenceIds: [],
      instances: [],
      users: [],
      problem: '当前叙事镜头已不存在，请重新选择范围',
    }
  const groups = expandedNodes(doc, scope.boardId)
  const active = new Map(
    shots
      .flatMap((shot) => activeShotNodes(shot, groups.get(shot.id) ?? []))
      .map((node) => [node.id, node]),
  )
  const rolePorts: Partial<Record<ShotSource['role'], string>> = {
    video: 'clips',
    speech: 'dialogue',
    sfx: 'sfx',
  }
  const sequences = [...doc.elements()].filter((node) => node.nodeType === SEQUENCE_TYPE)
  const associated = sequences.filter((sequence) => {
    const raw = Array.isArray(sequence.params?.clips) ? sequence.params.clips : []
    if (
      raw.some(
        (row) =>
          row?.narrative?.canvasId === scope.canvasId &&
          row.narrative.boardId === scope.boardId &&
          shotIds.has(row.narrative.shotId) &&
          !row.narrative.historical,
      )
    )
      return true
    return [...doc.edges()].some((edge) => {
      if (edge.to[0] !== sequence.id || !['clips', 'dialogue', 'sfx'].includes(edge.to[1]))
        return false
      const source = active.get(edge.from[0])?.params?.source as ShotSource | undefined
      if (!source || rolePorts[source.role] !== edge.to[1]) return false
      if (edge.to[1] === 'clips' && sequence.params?.instanceVersion === 2)
        return raw.some((row) => !row?.segment && row?.source === edge.from[0])
      return true
    })
  })
  const sequenceIds = associated.map((sequence) => sequence.id)
  const empty = { sequenceIds, instances: [], users: [] }
  if (scope.sequenceId && !sequenceIds.includes(scope.sequenceId))
    return { ...empty, sequenceId: scope.sequenceId, problem: '所选序列未关联当前画布与分镜' }
  if (!scope.sequenceId && associated.length > 1)
    return { ...empty, problem: '当前分镜关联多个序列，请明确选择本次序列范围' }
  const sequence = scope.sequenceId
    ? associated.find((node) => node.id === scope.sequenceId)
    : associated[0]
  if (!sequence) return empty
  const base = { ...empty, sequenceId: sequence.id }
  const parsed = sequenceNode.params.safeParse(sequence.params)
  if (
    !parsed.success ||
    parsed.data.instanceVersion !== 2 ||
    !parsed.data.clips.every(isSequenceInstance)
  )
    return { ...base, problem: '所选序列实例有损坏或未迁移的映射，请先修复，不能自动付费补缺' }
  const instances = (parsed.data.clips as SequenceInstance[]).filter((row) =>
    belongs(scope, row, doc),
  )
  for (const row of instances) {
    if (row.segment && row.sound === 'legacy')
      return { ...base, instances, problem: '固定段必须明确选择原生声、配音或混合路线' }
    if (row.segment && videoSegmentConflict(doc.elements(), row.segment))
      return { ...base, instances, problem: '同一固定段身份存在不同文件或出处，请先修复' }
    if (
      !row.segment &&
      ![...doc.edges()].some(
        (edge) =>
          edge.to[0] === sequence.id &&
          edge.to[1] === 'clips' &&
          edge.from[0] === row.source &&
          edge.from[1] === row.port &&
          (!row.edgeId || edge.id === row.edgeId),
      )
    )
      return { ...base, instances, problem: `剪辑实例 ${row.clipInstanceId} 的精确来源连线已断开` }
    if (!row.segment && row.narrative) {
      const source = sourceOf(doc, row.source)
      if (
        source?.storyboard !== scope.boardId ||
        source.shot !== scope.shotId ||
        source.role !== 'video' ||
        source.detached
      )
        return {
          ...base,
          instances,
          problem: '跨叙事镜头复用必须先固定具体段，不能跟随其他镜头的live候选',
        }
    }
  }
  const users = [
    ...new Map(
      instances
        .flatMap((row) => (row.segment ? segmentUsers(doc, row.segment.segmentId) : []))
        .map((user) => [JSON.stringify([user.sequenceId, user.clipInstanceId]), user]),
    ).values(),
  ]
  return { ...base, instances, users }
}

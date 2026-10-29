import { productionGoalHeads, type PleinDoc, type ProductionGoalScope } from '@plein/doc'
import { creationGuideFacts, type GuideFacts } from './facts'
import { readGuidePreferences } from './preferences'

export function goalScopeOf(facts: GuideFacts, canvasId: string): ProductionGoalScope | undefined {
  if (!facts.board) return undefined
  const selected = facts.board.production?.selection?.sequenceId
  if ((selected && !facts.sequence) || (facts.sequences.length > 1 && !facts.sequence))
    return undefined
  return {
    canvasId,
    boardId: facts.board.id,
    ...(facts.sequence ? { sequenceId: facts.sequence.id } : {}),
  }
}

export type GoalDurationCheck =
  | { state: 'unscoped' | 'concurrent' | 'missing' | 'unbounded' }
  | { state: 'within' | 'short' | 'long'; min?: number; max?: number }

/**
 * 分镜表与制作总览用同一范围判断：只比较明确对应这张表的唯一当前目标。
 * 计划时长是分镜里填的秒数之和，不代表实际成片时长。
 */
export function goalDurationCheck(
  doc: PleinDoc,
  canvasId: string,
  boardId: string,
  planned: number,
): GoalDurationCheck {
  const preferences = readGuidePreferences(canvasId)
  const facts = creationGuideFacts(doc, {
    canvasId,
    boardId,
    // 引导里为另一张分镜选的序列不能用于本表。
    ...(preferences.boardId === boardId ? { sequenceId: preferences.sequenceId } : {}),
  })
  const scope = goalScopeOf(facts, canvasId)
  if (!scope) return { state: 'unscoped' }
  const heads = productionGoalHeads(facts.board, scope)
  if (heads.length > 1) return { state: 'concurrent' }
  const duration = heads[0]?.content.duration
  if (!heads[0]) return { state: 'missing' }
  if (!duration || (duration.min === undefined && duration.max === undefined))
    return { state: 'unbounded' }
  const { min, max } = duration
  const state =
    min !== undefined && planned < min
      ? 'short'
      : max !== undefined && planned > max
        ? 'long'
        : 'within'
  return { state, min, max }
}

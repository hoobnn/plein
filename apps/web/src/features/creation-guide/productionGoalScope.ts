import type { ProductionGoalScope } from '@plein/doc'
import type { GuideFacts } from './facts'

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

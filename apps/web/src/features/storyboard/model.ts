import {
  detachShot as detachShotIn,
  type ExpandOptions,
  type ExpandResult,
  expandedNodes as expandedNodesIn,
  expandShots as expandShotsIn,
  planDiffs as planDiffsIn,
  runExpanded as runExpandedIn,
  syncExpanded as syncExpandedIn,
} from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import { currentResult, type CanvasElement } from '@plein/doc'
import type { ShotRole, SyncMode } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { nodeFactory } from '../../canvas/nodes'

/** 分镜展开 / 同步 / 批量运行的逻辑在 @plein/capabilities（纯文档操作，智能体也用），这里只接上画布 */

export {
  type ExpandOptions,
  type ExpandResult,
  type ShotSource,
  shotsOf,
} from '@plein/capabilities'

export const expandedNodes = (engine: Engine, boardId: string) =>
  expandedNodesIn(engine.doc, boardId)

const BATCH_ORDER = [
  ['image', 'plein/image'],
  ['video', 'plein/video'],
  ['speech', 'plein/speech'],
] as const

/** 目标镜头里下一步：有未展开的先 'expand'，再是下一类还没出结果的批量动作（按出图、视频、配音的顺序）；都展开且出齐返回 null */
export function nextBatchRole(
  expanded: ReadonlyMap<string, CanvasElement[]>,
  shotIds: readonly string[],
): 'expand' | 'image' | 'video' | 'speech' | null {
  if (shotIds.some((id) => !expanded.has(id))) return 'expand'
  for (const [role, type] of BATCH_ORDER)
    for (const id of shotIds)
      for (const el of expanded.get(id) ?? [])
        if (el.nodeType === type && !currentResult(el)) return role
  return null
}

export const planDiffs = (engine: Engine, boardId: string) => planDiffsIn(engine.doc, boardId)

export const syncExpanded = (engine: Engine, boardId: string, shotIds: string[], mode: SyncMode) =>
  syncExpandedIn(engine.doc, boardId, shotIds, mode)

export const detachShot = (engine: Engine, boardId: string, shotId: string) =>
  detachShotIn(engine.doc, boardId, shotId)

export const expandShots = (
  engine: Engine,
  boardId: string,
  shotIds: string[],
  catalog: Catalog | null,
  options?: ExpandOptions,
): ExpandResult => expandShotsIn(engine.doc, boardId, shotIds, nodeFactory(catalog), options)

export const runExpanded = (
  engine: Engine,
  boardId: string,
  shotIds: string[],
  role: ShotRole,
  run: (id: string) => void,
) => runExpandedIn(engine.doc, boardId, shotIds, role, run)

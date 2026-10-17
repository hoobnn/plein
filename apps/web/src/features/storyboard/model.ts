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

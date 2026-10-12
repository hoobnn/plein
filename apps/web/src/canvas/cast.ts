import { applyCast as applyCastIn, castOf as castOfIn } from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import type { CastEntry } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import { nodeFactory } from './nodes'

export { type CastResult, describeCast } from '@plein/capabilities'

/** 节点当前采用的文本结果；不是文本节点或还没跑过时为空 */
export const castOf = (engine: Engine, id: string) => castOfIn(engine.doc, id)

/** 按抽取结果建设定卡（逻辑见 @plein/capabilities），整个操作是一步撤销 */
export const applyCast = (
  engine: Engine,
  catalog: Catalog | null,
  sourceId: string,
  entries: CastEntry[],
) => applyCastIn(engine.doc, nodeFactory(catalog), sourceId, entries)

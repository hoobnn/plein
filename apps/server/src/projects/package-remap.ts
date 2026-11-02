import {
  readProductionGoals,
  remapProductionGoalScopes,
  copySourceMap,
  createSourceMap,
  readSourceMap,
  copyContinuity,
  createContinuityMap,
  readContinuity,
  createProductionGoals,
  remapSequenceCanvasScopes,
  snapshotTypedDeliveries,
  type DeliveryRecord,
  type NodeResult,
  type NodeRun,
} from '@plein/doc'
import { remapReferenceParams } from '@plein/plugin-sdk'
import {
  isAiAnalysisType,
  DELIVERY_CHECK_TYPE,
  AiDraftOrigin,
  AiSceneRequest,
  AiSummaryRequest,
} from '@plein/nodes'
import * as Y from 'yjs'
import { RUNNING_NOTE, settledRun } from './package-types'

/**
 * 画布文档里的引用跟着换新 id：参数里的资产库条目 id、运行状态与结果的 runId；运行中状态改成历史。
 * 导入时按 id 映射重写文档，与数据库写入分开。
 */

/** 深度替换 JSON 值里与映射表完全相同的字符串；没有变化时返回原对象 */
function remapValue(v: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v
  if (Array.isArray(v)) {
    const next = v.map((x) => remapValue(x, map))
    return next.some((x, i) => x !== v[i]) ? next : v
  }
  if (v && typeof v === 'object' && !(v instanceof Y.AbstractType)) {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      next[k] = remapValue(x, map)
      if (next[k] !== x) changed = true
    }
    return changed ? next : v
  }
  return v
}

export function remapDoc(data: Uint8Array, map: ReadonlyMap<string, string>): Uint8Array {
  const ydoc = new Y.Doc()
  try {
    Y.applyUpdate(ydoc, data)
    const elements = ydoc.getMap<Y.Map<unknown>>('elements')
    const localBindings = new Map([...elements.keys()].map((id) => [id, id]))
    ydoc.transact(() => {
      for (const m of elements.values()) {
        if (!(m instanceof Y.Map)) continue
        const production = m.get('production')
        if (production instanceof Y.Map) {
          // 无ID冲突的导入也可能保留canvasId。导入本身形成历史边界，
          // 不能仅依靠scope变化使原来的人工内容确认和制作决策失效。
          for (const key of ['confirmations', 'decisions']) {
            const records = production.get(key)
            if (!(records instanceof Y.Map)) continue
            for (const [id, record] of records.entries()) {
              if (record && typeof record === 'object' && !Array.isArray(record))
                records.set(id, { ...record, historical: true })
            }
          }
          const goals = readProductionGoals(production.get('goals'))
          const remapped = remapProductionGoalScopes(goals, map)
          if (remapped !== goals) production.set('goals', createProductionGoals(remapped))
          const sourceMap = readSourceMap(production.get('sourceMap'))
          if (sourceMap && (sourceMap.sources.length || sourceMap.proposals.length))
            production.set('sourceMap', createSourceMap(copySourceMap(sourceMap, localBindings)))
          const continuity = readContinuity(production.get('continuity'))
          if (
            continuity &&
            (continuity.subjects.length ||
              continuity.plans.length ||
              continuity.observations.length)
          )
            production.set(
              'continuity',
              createContinuityMap(copyContinuity(continuity, localBindings, map)),
            )
        }
        const params = m.get('params')
        if (m.get('nodeType') === DELIVERY_CHECK_TYPE && params instanceof Y.Map)
          params.set('historical', true)
        if (params instanceof Y.Map) {
          for (const [k, v] of params.entries()) {
            if (m.get('nodeType') === 'plein/sequence' && params.get('instanceVersion') === 2) {
              if (k === 'clips' && Array.isArray(v)) {
                params.set(k, remapSequenceCanvasScopes(params.toJSON(), map).clips)
                continue
              }
              if (['legacySourceSettings', 'subtitleTrack'].includes(k)) continue
            }
            // Captured model evidence stays at its original scope; imports require a new expect.
            if (
              (m.get('kind') === 'markdown' &&
                k === 'aiDraftOrigin' &&
                AiDraftOrigin.safeParse(v).success) ||
              (isAiAnalysisType(m.get('nodeType') as string) &&
                k === 'request' &&
                (AiSceneRequest.safeParse(v).success || AiSummaryRequest.safeParse(v).success))
            )
              continue
            const next = remapValue(v, map)
            if (next !== v) params.set(k, next)
          }
          const current = params.toJSON() as Record<string, unknown>
          const remapped = remapReferenceParams(current, map)
          if (remapped !== current) {
            for (const key of Object.keys(current))
              if (!Object.hasOwn(remapped, key)) params.delete(key)
            for (const [key, value] of Object.entries(remapped))
              if (!Object.hasOwn(current, key) || current[key] !== value) params.set(key, value)
          }
        }
        const results = m.get('results')
        const deliveries = m.get('deliveries')
        if (Array.isArray(deliveries)) {
          const next = (deliveries as DeliveryRecord[]).map((r) =>
            r && typeof r === 'object'
              ? {
                  ...r,
                  historical: true,
                  ...(map.has(r.runId) ? { runId: map.get(r.runId)! } : {}),
                }
              : r,
          )
          if (next.some((r, i) => r !== deliveries[i]))
            m.set('deliveries', snapshotTypedDeliveries(next))
        }
        if (Array.isArray(results)) {
          const next = (results as NodeResult[]).map((r) =>
            r && typeof r === 'object' && map.has(r.runId) ? { ...r, runId: map.get(r.runId)! } : r,
          )
          if (next.some((r, i) => r !== results[i])) m.set('results', next)
        }
        const run = m.get('run') as NodeRun | undefined
        if (run && typeof run === 'object' && typeof run.status === 'string') {
          let next = settledRun(run, RUNNING_NOTE)
          if (map.has(next.id)) next = { ...next, id: map.get(next.id)! }
          if (next !== run) m.set('run', next)
        }
      }
    })
    return Y.encodeStateAsUpdate(ydoc)
  } finally {
    ydoc.destroy()
  }
}

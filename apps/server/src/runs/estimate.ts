import { createDoc, currentResult, SYSTEM_ORIGIN } from '@plein/doc'
import { NodeRunError } from '../plugins/provider-protocol'
import { type NodeRuns, runGraph } from './runs'

export type EstimateScope = 'node' | 'upstream' | 'downstream' | 'frame'
/** run：一定会调用平台；maybe：只在上游重做、输入真的变了才会调用；reused：沿用现有结果 */
export type EstimateStatus = 'run' | 'maybe' | 'reused'

export interface CostEstimate {
  scope: EstimateScope
  nodes: Array<{
    id: string
    name: string
    type: string
    model?: string
    will_run: EstimateStatus
    price?: { amount: number; currency: string }
    note?: string
  }>
  /** 一定会发生的调用 */
  calls: number
  /** 可能追加的调用（上游重做后输入变了才会跑） */
  maybe_calls: number
  /** 一定会发生的费用：各币种分别合计；没配价格的调用个数记在 unknown，不当成 0 */
  cost: Cost
  /** 含可能追加的调用的上限 */
  max_cost: Cost
}
interface Cost {
  prices: Array<{ amount: number; currency: string }>
  unknown: number
}

const sum = (items: Array<{ price?: { amount: number; currency: string } }>): Cost => {
  const by = new Map<string, number>()
  let unknown = 0
  for (const i of items) {
    if (i.price) by.set(i.price.currency, (by.get(i.price.currency) ?? 0) + i.price.amount)
    else unknown++
  }
  return {
    prices: [...by].map(([currency, amount]) => ({ currency, amount: Number(amount.toFixed(4)) })),
    unknown,
  }
}

/**
 * 不调用平台地估算一次运行的调用次数与费用，口径与运行本身一致（同样的目标范围、
 * 同样的「结果还有效就沿用」判定）、价格口径与影响面板一致（模型没配价格算 unknown）。
 */
export async function estimateRun(
  runs: NodeRuns,
  canvasId: string,
  ownerId: string,
  req: { scope: EstimateScope; id: string; video?: boolean },
): Promise<CostEstimate> {
  const lease = runs.rooms.acquire(canvasId)
  const doc = createDoc(lease.room.doc, { origin: SYSTEM_ORIGIN })
  try {
    const signal = new AbortController().signal
    const root = doc.get(req.id)
    if (req.scope === 'frame') {
      if (root?.kind !== 'frame') throw new NodeRunError('not_found', '分组框不存在')
    } else if (root?.kind !== 'node') throw new NodeRunError('not_found', '节点不存在')
    const graph = runGraph(doc)
    let targets: string[]
    if (req.scope === 'node') targets = runs.isJobNode(root) ? [req.id] : []
    else if (req.scope === 'frame') targets = runs.groupTargets(doc, req.id, req.video ?? false)
    else {
      const around = req.scope === 'upstream' ? graph.ancestors(req.id) : graph.descendants(req.id)
      targets = [req.id, ...around].filter((id) => runs.isJobNode(doc.get(id)))
    }
    // 先算上游再算下游：祖先更多的排后面
    const order = [...new Set(targets)].sort(
      (a, b) => graph.ancestors(a).size - graph.ancestors(b).size,
    )
    const decided = new Map<string, EstimateStatus>()
    const nodes: CostEstimate['nodes'] = []
    for (const id of order) {
      const el = doc.get(id)!
      const inspection = await runs.inspect(doc, el, ownerId, signal, canvasId)
      const fresh = await runs.isFresh(doc, el, ownerId, signal)
      let status: EstimateStatus
      if (req.scope === 'node' || (req.scope === 'downstream' && id === req.id)) status = 'run'
      else if (!fresh) status = 'run'
      else {
        const dependsOnRerun = [...graph.ancestors(id)].some(
          (up) => (decided.get(up) ?? 'reused') !== 'reused',
        )
        status = dependsOnRerun ? 'maybe' : 'reused'
      }
      // 下游里没有结果的节点：上游一重做就会跑
      if (status === 'reused' && !currentResult(el)) status = 'run'
      decided.set(id, status)
      const model = inspection.input.model
      const price = runs.priceOf(model)
      nodes.push({
        id,
        name: el.name ?? el.nodeType ?? id,
        type: el.nodeType ?? '',
        ...(model ? { model: model.ref } : {}),
        will_run: status,
        ...(price ? { price: { amount: price.amount, currency: price.currency } } : {}),
        ...(inspection.input.status !== 'ready' && status !== 'reused'
          ? {
              note:
                inspection.input.blocked[0]?.message ?? '输入现在还没准备好，可能要等上游先出结果',
            }
          : {}),
      })
    }
    const sure = nodes.filter((n) => n.will_run === 'run')
    const maybe = nodes.filter((n) => n.will_run === 'maybe')
    return {
      scope: req.scope,
      nodes,
      calls: sure.length,
      maybe_calls: maybe.length,
      cost: sum(sure),
      max_cost: sum([...sure, ...maybe]),
    }
  } finally {
    doc.destroy()
    lease.release()
  }
}

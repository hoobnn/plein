import { capabilityFor } from '@plein/capabilities'
import { API, type GroupRunStarted, type ImpactDecision, type ImpactReport } from '@plein/protocol'
import { z } from 'zod'
import { callInternal } from './internal-api'
import type { ServerContext } from './tools'

const cap = capabilityFor<ServerContext>()
const id = z.string().min(1).max(200)
const IMPACT = /^\/api\/canvases\/[^/]+\/impact$/
const KEEP = /^\/api\/canvases\/[^/]+\/impact\/keep$/
const DECISION = /^\/api\/canvases\/[^/]+\/impact\/keep\/[^/]+$/
const RUN = /^\/api\/canvases\/[^/]+\/impact\/run$/

export const getImpact = cap({
  name: 'get_impact',
  title: '查看修改的影响',
  group: 'read',
  where: 'server',
  effect: 'read',
  description:
    '与界面「影响」面板同一份分析：改了提示词、参数、模型、参考或上游之后，哪些节点的结果过期了（nodes：原因 causes、建议 suggest = rerun/review/keep/sync、是否已有可沿用的候选 cached、预估费用 price），分镜表与节点不同步的镜头（plan），序列里的问题（sequence），以及汇总（summary：要调用平台的个数 pending、费用合计 cost，缺价格的个数记在 cost.unknown）。只读，不调用平台。nodes 分页：条数等于 limit 时用 offset 继续。每个节点的 input_hash 用于 keep_stale。之后用 run_impact 重做或 keep_stale 保留。',
  input: z.object({
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(40),
  }),
  run: async (ctx, a) => {
    const report = await callInternal<ImpactReport>(ctx, {
      method: 'GET',
      path: API.canvasImpact(ctx.env.canvasId),
      pathname: IMPACT,
    })
    const nodes = report.nodes.slice(a.offset, a.offset + a.limit).map(({ inputHash, ...n }) => ({
      ...n,
      node_id: n.nodeId,
      ...(inputHash ? { input_hash: inputHash } : {}),
    }))
    return {
      summary: report.summary,
      total_nodes: report.nodes.length,
      nodes,
      ...(a.offset + nodes.length < report.nodes.length
        ? { next_offset: a.offset + nodes.length }
        : {}),
      plan: report.plan,
      sequence: report.sequence,
      decisions: report.decisions.slice(0, 20),
    }
  },
})

export const keepStale = cap({
  name: 'keep_stale',
  title: '保留过期结果',
  group: 'edit',
  where: 'server',
  effect: 'edit',
  description:
    '确认保留某些过期节点的现有结果（不重新生成）。nodes 里每项带 get_impact 返回的 node_id 和 input_hash；保留决定绑定当时的输入，之后输入再变就不再适用。查看之后输入又变了会失败，重新 get_impact 再试。返回新记录的保留决定（含 id，可用 revoke_keep 撤销）。',
  input: z.object({
    nodes: z
      .array(z.object({ node_id: id, input_hash: z.string().max(128) }))
      .min(1)
      .max(500),
    note: z.string().max(500).optional(),
  }),
  run: (ctx, a) =>
    callInternal<ImpactDecision[]>(ctx, {
      method: 'POST',
      path: API.impactKeep(ctx.env.canvasId),
      pathname: KEEP,
      body: {
        nodes: a.nodes.map((n) => ({ nodeId: n.node_id, inputHash: n.input_hash })),
        ...(a.note ? { note: a.note } : {}),
      },
    }),
})

export const revokeKeep = cap({
  name: 'revoke_keep',
  title: '撤销保留决定',
  group: 'edit',
  where: 'server',
  effect: 'edit',
  description:
    '撤销一条保留决定，让对应节点重新按过期处理。decision_id 来自 get_impact 的 decisions 或 keep_stale 的返回。',
  input: z.object({ decision_id: id }),
  run: async (ctx, a) => {
    await callInternal(
      ctx,
      {
        method: 'DELETE',
        path: API.impactDecision(ctx.env.canvasId, a.decision_id),
        pathname: DECISION,
      },
      '先用 get_impact 查看 decisions',
    )
    return { revoked: a.decision_id }
  },
})

export const runImpact = cap({
  name: 'run_impact',
  title: '运行受影响的节点',
  group: 'run',
  where: 'server',
  effect: 'run',
  approval: (a) => ({ reason: `运行 ${a.node_ids.length} 个受影响的节点`, ids: a.node_ids }),
  description:
    '只运行指定的受影响节点（会产生费用，视频尤其贵，需要用户确认），与影响面板的「重做」一致：默认优先沿用已有的按当前输入生成过的候选，不调用平台；force=true 则全部重新生成。先 get_impact 选出 node_ids（通常是 suggest=rerun 的）。立即返回 group_id，用 wait_for_group 等结果。',
  input: z.object({
    node_ids: z.array(id).min(1).max(500),
    force: z.boolean().default(false).describe('不沿用已有候选，全部重新生成'),
  }),
  run: async (ctx, a) => {
    const started = await callInternal<GroupRunStarted>(ctx, {
      method: 'POST',
      path: API.impactRun(ctx.env.canvasId),
      pathname: RUN,
      body: { nodes: a.node_ids, force: a.force },
    })
    ctx.env.onGroup?.(started.groupId)
    return { group_id: started.groupId, total: started.total }
  },
})

export const impactCapabilities = [getImpact, keepStale, revokeKeep, runImpact]

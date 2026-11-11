import { CapabilityError, capabilityFor } from '@plein/capabilities'
import { z } from 'zod'
import { NodeRunError } from '../plugins/provider-protocol'
import { estimateRun } from '../runs/estimate'
import type { ServerContext } from './tools'

const cap = capabilityFor<ServerContext>()

export const estimateCost = cap({
  name: 'estimate_cost',
  title: '估算运行费用',
  group: 'read',
  where: 'server',
  effect: 'read',
  description:
    '运行之前先估价，不调用平台、不花钱。id 与 scope 的组合和运行工具一致：node = 只运行这个节点（run_node）；upstream = 它和需要重做的上游（run_flow upstream）；downstream = 它和跟着重跑的下游（run_flow downstream）；frame = id 是分组框，整组运行（run_frame，video=true 才计入视频节点）。返回逐节点的 will_run（run 一定调用平台；maybe 只在上游重做后输入变了才会调用；reused 沿用现有结果，不花钱），calls / maybe_calls 次数，以及 cost（一定发生的费用）和 max_cost（含 maybe 的上限）。费用按币种分别合计；模型没配价格的调用不会被当成 0，而是计入 unknown，说明总价不完整。',
  input: z.object({
    id: z.string().min(1).max(200).describe('节点 id；scope=frame 时是分组框 id'),
    scope: z.enum(['node', 'upstream', 'downstream', 'frame']),
    video: z.boolean().default(false).describe('scope=frame 时是否计入视频节点'),
  }),
  run: async (ctx, a) => {
    try {
      return await estimateRun(ctx.env.runs, ctx.env.canvasId, ctx.env.ownerId, {
        scope: a.scope,
        id: a.id,
        video: a.video,
      })
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

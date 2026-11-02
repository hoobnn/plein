import { CapabilityError, capabilityFor, need, resultSummary, shotsOf } from '@plein/capabilities'
import type { StoryboardBatchPlan } from '@plein/protocol'
import { z } from 'zod'
import { NodeRunError } from '../plugins/provider-protocol'
import { RUN_LIMIT } from './approvals'
import type { ServerContext } from './tool-registry'
import { InspectNodeInput, preparedInputPage } from './input-view'
import { toToolResult } from './mcp'

const id = z.string().min(1).max(200)
const serverCapability = capabilityFor<ServerContext>()

/** 单次等待运行结果的上限：Codex 默认 60 秒工具超时，留出余量 */
export const MAX_WAIT_S = 50

/** 确认卡片里的元素名（找不到时给 id） */
const elName = (ctx: ServerContext, elId: string) =>
  ctx.withDoc((doc) => {
    const el = doc.get(elId)
    return el ? `「${el.name ?? el.kind}」` : elId
  })

export const runNode = serverCapability({
  name: 'run_node',
  title: '运行节点',
  description: `运行节点（调用模型生成，会产生费用）并等待结果，最多等 ${MAX_WAIT_S} 秒；超时则返回 running，之后用 wait_for_run 继续等。上游节点需要先有结果。`,
  group: 'run',
  where: 'server',
  effect: 'run',
  // 生成视频要确认，节点名写进确认；一轮跑满要问（always 下声明说不问时回退统一说法）
  approval: (a, ctx, { changes }) => {
    const node = elName(ctx, a.id)
    const capability = ctx.withDoc((doc) => {
      const type = doc.get(a.id)?.nodeType
      return type ? ctx.nodes.latest(type)?.def.capability : undefined
    })
    if (capability === 'video.generate')
      return { reason: `生成视频 ${node}（较贵、较慢）`, ids: [a.id] }
    if (changes.runCount >= RUN_LIMIT)
      return { reason: `运行 ${node}：这一轮已经运行了 ${changes.runCount} 次`, ids: [a.id] }
    return null
  },
  // 输入预检：不花钱地看一次实际输入，状态不对就拦下，不进审批
  prepare: async (a, ctx) => {
    const input = await ctx.env.runs.preview(ctx.env.canvasId, a.id, ctx.env.ownerId)
    if (input.status !== 'ready')
      return {
        answer: {
          content: [{ type: 'text', text: input.blocked.map((b) => b.message).join('\n') }],
          isError: true,
        },
      }
    return null
  },
  input: z.object({
    id,
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
  }),
  run: async (ctx, { id, wait_seconds }) => {
    const { env } = ctx
    let runId: string
    try {
      runId = env.runs.start(env.canvasId, id, env.ownerId)
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
    env.onRun?.(id, runId)
    return waitRun(ctx, id, runId, wait_seconds)
  },
})

export const inspectNodeInput = serverCapability({
  name: 'inspect_node_input',
  title: '检查节点实际输入',
  description:
    '只读检查节点最终送入模型的提示词、参考顺序、模型、音色、提示和阻断，不运行节点。默认返回字段目录，完整原文用 field_path（/prompt、/refs、/inputs、/model、/notices、/blocked）；数组沿 next_offset，文字沿 next_text_offset 续读，并携带 expected_version。complete 只表示当前字段读完，目录中的预览不是完整原文。',
  group: 'read',
  where: 'server',
  effect: 'read',
  input: InspectNodeInput,
  run: async (ctx, a) => {
    try {
      return preparedInputPage(
        await ctx.env.runs.preview(ctx.env.canvasId, a.id, ctx.env.ownerId),
        a,
      )
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

export const waitForRun = serverCapability({
  name: 'wait_for_run',
  title: '等待结果',
  description: `继续等待节点当前这次运行，最多 ${MAX_WAIT_S} 秒。`,
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({
    id,
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
  }),
  run: (ctx, { id, wait_seconds }) => {
    const run = ctx.withDoc((doc) => need(doc, id).run)
    if (!run) throw new CapabilityError('这个节点还没运行过')
    return waitRun(ctx, id, run.id, wait_seconds)
  },
})

export const cancelRun = serverCapability({
  name: 'cancel_run',
  title: '取消运行',
  description: '取消节点正在进行的运行。',
  group: 'run',
  where: 'server',
  effect: 'edit',
  input: z.object({ id }),
  run: (ctx, { id }) => {
    ctx.env.runs.cancel(ctx.env.canvasId, id)
    return '已取消'
  },
})

export const runFlow = serverCapability({
  name: 'run_flow',
  title: '运行上下游',
  description:
    '从一个节点出发批量运行，和画布上的“运行到此处 / 运行下游”是同一套调度：upstream 运行它和它的全部上游（没改动的沿用旧结果），downstream 重新运行它并跟着重跑输入变了的下游。会产生费用，通常需要用户确认。立即返回 group_id，用 wait_for_group 等结果。',
  group: 'run',
  where: 'server',
  effect: 'run',
  approval: (a, ctx) => ({
    reason: `${a.scope === 'upstream' ? '运行到' : '运行下游：'}${elName(ctx, a.id)}`,
    ids: [a.id],
  }),
  input: z.object({
    id,
    scope: z.enum(['upstream', 'downstream']),
    force: z.boolean().default(false).describe('忽略缓存，范围内全部重新运行'),
  }),
  run: (ctx, a) => {
    const { env } = ctx
    try {
      const started = env.runs.runFlow(env.canvasId, a.id, env.ownerId, {
        scope: a.scope,
        force: a.force,
      })
      env.onGroup?.(started.groupId)
      return { group_id: started.groupId, total: started.total }
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

export const runFrame = serverCapability({
  name: 'run_frame',
  title: '整组运行',
  description:
    '整组运行一个 Frame 里的节点（按连线顺序，没改动的沿用旧结果）。默认不含视频节点，video=true 才包括。会产生费用，需要用户确认。立即返回 group_id，用 wait_for_group 等结果。',
  group: 'run',
  where: 'server',
  effect: 'run',
  approval: (a, ctx) => ({
    reason: `整组运行 ${elName(ctx, a.frame_id)}${a.video ? '（包括视频）' : ''}`,
    ids: [a.frame_id],
  }),
  input: z.object({
    frame_id: id,
    video: z.boolean().default(false).describe('是否包含视频节点（贵且慢）'),
    force: z.boolean().default(false),
  }),
  run: (ctx, a) => {
    const { env } = ctx
    try {
      const started = env.runs.runGroup(env.canvasId, a.frame_id, env.ownerId, {
        video: a.video,
        force: a.force,
      })
      env.onGroup?.(started.groupId)
      return { group_id: started.groupId, total: started.total }
    } catch (err) {
      if (err instanceof NodeRunError) throw new CapabilityError(err.message)
      throw err
    }
  },
})

export const waitForGroup = serverCapability({
  name: 'wait_for_group',
  title: '等待整组结果',
  description: `等待一次整组 / 上下游运行结束，最多 ${MAX_WAIT_S} 秒；返回各状态的节点数。`,
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({
    group_id: id,
    wait_seconds: z.number().min(0).max(MAX_WAIT_S).default(MAX_WAIT_S),
  }),
  run: async (ctx, { group_id, wait_seconds }) => {
    const deadline = Date.now() + wait_seconds * 1000
    for (;;) {
      const state = ctx.env.runs.groupState(group_id, ctx.env.ownerId)
      if (!state) throw new CapabilityError(`没有运行记录 ${group_id}`)
      if (state.status !== 'running' || Date.now() >= deadline) return state
      await new Promise((r) => setTimeout(r, 500))
    }
  },
})

export const listStale = serverCapability({
  name: 'list_stale',
  title: '检查过期结果',
  description:
    '列出结果已经过期、需要重跑的节点：stale 是自己的参数或输入改了的，upstream 是因为上游过期跟着要重跑的。',
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({}),
  run: (ctx) => ctx.env.runs.staleNodes(ctx.env.canvasId, ctx.env.ownerId),
})

async function waitRun(ctx: ServerContext, nodeId: string, runId: string, seconds: number) {
  const status = await Promise.race([
    ctx.env.runs.wait(runId),
    new Promise<'running'>((r) => setTimeout(() => r('running'), seconds * 1000)),
  ])
  return ctx.withDoc((doc) => {
    const el = need(doc, nodeId)
    const run = el.run?.id === runId ? el.run : undefined
    const results = (el.results ?? []).filter((r) => r.runId === runId).map(resultSummary)
    return {
      status,
      ...(run?.progress !== undefined && status === 'running' ? { progress: run.progress } : {}),
      ...(run?.error ? { error: run.error } : {}),
      ...(run?.message && status === 'running' ? { message: run.message } : {}),
      results,
    }
  })
}

const StoryboardRun = z.object({
  id: id.describe('分镜节点'),
  role: z.enum(['image', 'video', 'speech', 'sfx']),
  sequence_id: id.optional().describe('本次叙事映射的精确序列；关联多个序列时必须明确选择'),
  shot_ids: z.array(id).min(1).max(500).optional().describe('只跑这些镜头；不填补齐全部镜头'),
  reuse_existing: z
    .boolean()
    .optional()
    .describe('沿用已有采用结果；默认全部补缺、指定镜头出新候选'),
  preview_only: z
    .boolean()
    .default(false)
    .describe('只读生成清单，不执行；可用返回 token 确认相同范围'),
  token: id.optional().describe('已审阅清单的短期 token；不可跨范围或服务重启后沿用'),
})

async function storyboardPlan(ctx: ServerContext, a: z.output<typeof StoryboardRun>) {
  const { env } = ctx
  try {
    if (a.token) {
      const plan = ctx.storyboardBatches.get(env.canvasId, a.id, env.ownerId, a.token)
      if (
        plan.request.role !== a.role ||
        (a.sequence_id !== undefined &&
          (plan.request.sequenceId ?? plan.scope?.sequenceId) !== a.sequence_id) ||
        (a.reuse_existing !== undefined && plan.request.reuseExisting !== a.reuse_existing) ||
        (a.shot_ids &&
          JSON.stringify(plan.request.shotIds) !== JSON.stringify([...new Set(a.shot_ids)]))
      )
        throw new CapabilityError('清单范围与请求不一致，请重新检查')
      return plan
    }
    const shotIds =
      a.shot_ids ??
      ctx.withDoc((doc) => {
        const shots = shotsOf(need(doc, a.id))
        if (!shots.length) throw new CapabilityError(`${a.id} 不是分镜节点，或还没有镜头`)
        return shots.map((shot) => shot.id)
      })
    return await ctx.storyboardBatches.preview(env.canvasId, a.id, env.ownerId, {
      shotIds,
      role: a.role,
      ...(a.sequence_id ? { sequenceId: a.sequence_id } : {}),
      reuseExisting: a.reuse_existing ?? a.shot_ids === undefined,
    })
  } catch (error) {
    if (error instanceof NodeRunError) throw new CapabilityError(error.message)
    throw error
  }
}

function storyboardReview(plan: StoryboardBatchPlan) {
  const { token: _token, ...review } = plan
  return review
}

async function commitStoryboard(ctx: ServerContext, plan: StoryboardBatchPlan) {
  const { env } = ctx
  try {
    const result = await ctx.storyboardBatches.commit(
      env.canvasId,
      plan.sourceId,
      env.ownerId,
      plan.token,
      env.execution?.assertOpen,
    )
    if ('changed' in result)
      return {
        status: 'input_changed',
        plan: result.changed,
        next: '输入或任务已变化，原批准未执行。重新审阅清单后用 run_storyboard 携带新 token；不会自动提交新清单。',
      }
    env.onGroup?.(result.started.groupId)
    return { group_id: result.started.groupId, total: result.started.total, summary: plan.summary }
  } catch (error) {
    if (error instanceof NodeRunError) throw new CapabilityError(error.message)
    throw error
  }
}

export const runStoryboard = serverCapability({
  name: 'run_storyboard',
  title: '批量运行分镜',
  description:
    '批量运行分镜的一类节点：image、video、speech、sfx。与界面共用清单，列明实际输入、准备、沿用、阻塞、跳过及费用未知。preview_only=true 只预检；默认补齐未完成项，指定 shot_ids 默认出新候选。会话按确认模式批准具体清单，批准后只提交原 token；输入变化返回 input_changed 和新清单，必须重新审阅。所有类型返回 group_id，用 wait_for_group 等待。',
  group: 'run',
  where: 'server',
  effect: (a) => (a.preview_only ? 'read' : 'run'),
  approval: (a, ctx) => {
    const what = { image: '分镜图', video: '镜头视频', speech: '配音', sfx: '音效' }[a.role] ?? ''
    return { reason: `批量生成${elName(ctx, a.id)}的${what}`, ids: [a.id] }
  },
  // 先出批次清单：preview 只读；要生成的先请用户审阅，批准后只提交原 token
  prepare: async (raw, ctx) => {
    const a = StoryboardRun.parse(raw)
    const plan = await storyboardPlan(ctx, a)
    ctx.env.execution?.assertOpen()
    if (a.preview_only) return { answer: toToolResult({ status: 'ready_for_review', plan }) }
    if (!plan.summary.run)
      return { answer: toToolResult({ status: 'nothing_to_run', plan: storyboardReview(plan) }) }
    const review = storyboardReview(plan)
    return {
      request: { storyboardBatch: review },
      detail: { plan: review },
      next: '具体批量清单已展示给用户。调用 await_approval 等原调用结果，不重复调用 run_storyboard；若返回 input_changed，重新审阅新清单后再请求确认。',
      // 批准后的恢复入口由调度器串行化；无需确认的直接执行不再排队（外层已串行化）
      serialize: true,
      run: async () => {
        ctx.env.execution?.assertOpen()
        return toToolResult(await commitStoryboard(ctx, plan))
      },
    }
  },
  input: StoryboardRun,
  run: async (ctx, raw) => {
    const a = StoryboardRun.parse(raw)
    const plan = await storyboardPlan(ctx, a)
    if (a.preview_only)
      return {
        status: 'ready_for_review',
        plan,
        next: '审阅清单后调用 run_storyboard，携带相同 id、role 和 token。',
      }
    if (!plan.summary.run) return { status: 'nothing_to_run', plan: storyboardReview(plan) }
    return commitStoryboard(ctx, plan)
  },
})

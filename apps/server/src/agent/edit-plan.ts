import { CapabilityError, capabilityFor, clip } from '@plein/capabilities'
import { type EditEstimate, type EditPlan, EditScope } from '@plein/protocol'
import { z } from 'zod'
import { NodeRunError } from '../plugins/host'
import type { ServerContext } from './tools'

/** 提出修改方案的工具名：会话据此把确认单显示成方案卡片 */
export const PROPOSE_EDIT = 'propose_edit'
export const APPLY_EDIT = 'apply_edit_plan'

const id = z.string().min(1).max(200)
const serverCapability = capabilityFor<ServerContext>()

const plansOf = (ctx: ServerContext) => {
  if (!ctx.env.plans) throw new CapabilityError('这里不能用修改方案')
  return ctx.env.plans
}

const rethrow = (err: unknown): never => {
  if (err instanceof NodeRunError) throw new CapabilityError(err.message)
  throw err
}

const cost = (e: EditEstimate) =>
  e.calls === 0
    ? '不调用平台'
    : `调用平台 ${e.calls} 次，${
        e.cost.currency
          ? `约 ${Number(e.cost.amount.toFixed(2))} ${e.cost.currency}${e.cost.unknown ? `，另有 ${e.cost.unknown} 次价格未知` : ''}`
          : '价格未知'
      }`

const shotLabel = (s: { shot?: { no?: number } }) => (s.shot?.no ? `第 ${s.shot.no} 镜` : undefined)

const show = (v: unknown) => (typeof v === 'string' ? clip(v, 200) : v)

/** 给模型看的方案摘要 */
export function planBrief(plan: EditPlan) {
  return {
    plan_id: plan.id,
    status: plan.status,
    summary: plan.summary,
    targets: plan.targets.map((t) => ({
      id: t.nodeId,
      name: t.name,
      ...(t.shot ? { shot_id: t.shot.id, shot: shotLabel(t) } : {}),
      changes: t.changes.map((c) => ({
        field: c.key,
        before: show(c.before),
        after: show(c.after),
      })),
      refs: t.refs.map(
        (r) => `${r.name}：送 ${r.sent.length} 张${r.reason ? `（${r.reason}）` : ''}`,
      ),
      ...(t.issues.length ? { issues: t.issues.map((i) => i.message) } : {}),
    })),
    steps: plan.steps.map((s) => ({
      id: s.nodeId,
      name: s.name,
      ...(s.shot ? { shot: shotLabel(s) } : {}),
      stage: s.stage,
      scope: s.scope,
      ...(s.cached ? { cached: true } : {}),
    })),
    keep: plan.keep.map((k) => `${k.name}：${k.reason}`),
    untouched: plan.untouched,
    estimate: {
      text: cost(plan.estimate.text),
      images: cost(plan.estimate.images),
      full: cost(plan.estimate.full),
    },
    ...(plan.changed ? { changed: plan.changed } : {}),
    ...(plan.revised ? { revised_by_user: plan.revised } : {}),
    ...(plan.applied
      ? {
          applied: {
            scope: plan.applied.scope,
            targets: plan.applied.targets,
            nodes: plan.applied.nodes,
            ...(plan.applied.groupId ? { group_id: plan.applied.groupId } : {}),
          },
        }
      : {}),
  }
}

/** 执行结果给模型的下一步提示 */
export function applyNext(plan: EditPlan) {
  if (plan.status === 'stale')
    return '批准后目标变了，旧方案没有执行。重新看一下这些节点，再用 propose_edit 提出新方案。'
  if (!plan.applied?.groupId) return '文字已经写进画布，没有调用平台。'
  return '文字已经写进画布，方案里的节点开始运行：用 wait_for_group 等结果，跑完用 view_media 看效果。'
}

const proposeEdit = serverCapability({
  name: PROPOSE_EDIT,
  title: '提出修改方案',
  description:
    '修改已有镜头 / 节点（如“让第三镜头更紧张”）前先出方案：给出每个目标节点要改的参数（提示词、台词等，按键合并），返回目标与字段前后值、改完后实际送入的参考、要重做的节点和执行阶段、保留项，以及三种批准范围（text 只改文字 / images 只出候选图 / full 完整方案）的预计调用次数和费用。不改画布、不调用平台；用户批准后才执行，批准时目标变了不会执行旧方案。',
  group: 'run',
  where: 'server',
  effect: 'read',
  input: z.object({
    summary: z.string().min(1).max(300).describe('一句话说明这次要改成什么样'),
    edits: z
      .array(
        z.object({
          id: id.describe('要改的节点'),
          params: z.record(z.string(), z.unknown()).describe('要改的参数，只给出改动的键'),
        }),
      )
      .min(1)
      .max(50),
  }),
  run: async (ctx, a) => {
    try {
      const plan = await plansOf(ctx).propose(ctx.env.canvasId, ctx.env.ownerId, a)
      return {
        ...planBrief(plan),
        next: '把方案告诉用户，请用户选择批准范围，再用 apply_edit_plan 按用户选的范围执行。',
      }
    } catch (err) {
      return rethrow(err)
    }
  },
})

const applyEdit = serverCapability({
  name: APPLY_EDIT,
  title: '执行修改方案',
  description:
    '按用户批准的范围执行 propose_edit 提出的方案：text 只把文字写进画布（不调用平台），images 写入文字并只重新生成方案里的图片，full 执行全部步骤。only 只批准部分目标（目标节点 id 或镜头 id），skip 列出用户不想重做的步骤（节点 id）。方案绑定的对象在提出后变了时不执行，返回 stale，要重新提出。',
  group: 'run',
  where: 'server',
  effect: (a) => (a.scope === 'text' ? 'edit' : 'run'),
  input: z.object({
    plan_id: id,
    scope: EditScope,
    only: z.array(id).min(1).max(200).optional(),
    skip: z.array(id).max(200).optional(),
  }),
  run: async (ctx, a) => {
    try {
      const plan = await plansOf(ctx).apply(
        a.plan_id,
        ctx.env.ownerId,
        {
          scope: a.scope,
          ...(a.only ? { only: a.only } : {}),
          ...(a.skip ? { skip: a.skip } : {}),
        },
        { write: (fn) => ctx.withDoc(fn), onGroup: (g) => ctx.env.onGroup?.(g) },
      )
      return { ...planBrief(plan), next: applyNext(plan) }
    } catch (err) {
      return rethrow(err)
    }
  },
})

export const editPlanCapabilities = [proposeEdit, applyEdit]

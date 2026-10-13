import { CapabilityError, type Effect } from '@plein/capabilities'
import type { AgentItem } from '@plein/protocol'
import { z } from 'zod'
import type { Approval, Approvals } from './approvals'
import { defineTool, type McpTool } from './mcp'

export type PlanItem = Extract<AgentItem, { type: 'plan' }>
type StepStatus = PlanItem['steps'][number]['status']

/** 计划确认单的工具名：会话据此把确认单显示成计划卡片 */
export const PLAN_TOOL = 'propose_plan'

/**
 * 计划模式：这一轮先只读了解情况，用 propose_plan 列出步骤，用户同意后才能改画布或运行，
 * 执行中用 update_plan 逐步打勾。不在计划模式时，大任务也可以主动先出计划。
 */
export class AgentPlan {
  /** 这一轮必须先出计划 */
  private required = false
  private approved = false
  private item: PlanItem | null = null

  constructor(private onChange: (item: PlanItem) => void) {}

  /** 这一轮是计划模式 */
  get planMode() {
    return this.required
  }

  /** 新的一轮 */
  begin(required: boolean) {
    this.required = required
    this.approved = false
    this.item = null
  }

  /** 计划模式下，计划还没被同意时拦下会改动画布的调用；返回给模型的话，放行时为 null */
  blocked(effect: Effect): string | null {
    if (!this.required || this.approved || effect === 'read') return null
    return this.item?.status === 'pending'
      ? '计划还在等用户同意：调用 await_approval 等待，同意之前不能改画布或运行。'
      : '这一轮是计划模式：先用只读工具了解情况，再调用 propose_plan 列出步骤，用户同意后才能改画布或运行。'
  }

  /** 确认单状态变了：计划卡片跟着变 */
  onApproval(a: Approval) {
    if (!this.item || this.item.id !== a.id) return
    if (a.status === 'approved') this.approved = true
    this.set({ ...this.item, status: a.status })
  }

  tools(approvals: Approvals): McpTool[] {
    return [
      defineTool({
        name: PLAN_TOOL,
        description:
          '把要做的事列成计划请用户同意（任务较大、要建很多节点或运行多次时用；计划模式下必须先用）。返回 needs_approval 后调用 await_approval 等用户；同意后按步骤执行，每开始、完成一步调用 update_plan。',
        input: z.object({
          summary: z.string().max(300).optional().describe('一句话说明要做成什么'),
          steps: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(12)
            .describe('每步一句话，会花钱的步骤写明（如“生成 3 张分镜图”）'),
        }),
        run: ({ summary, steps }) => {
          if (this.item?.status === 'pending')
            throw new CapabilityError('上一个计划还在等用户同意，先调用 await_approval')
          const a = approvals.create(
            PLAN_TOOL,
            { reason: summary ?? '按计划执行', ids: [] },
            async () =>
              '用户同意了这个计划。按步骤执行：每开始一步调用 update_plan 标成 doing，做完标成 done。',
          )
          this.approved = false
          this.set({
            id: a.id,
            type: 'plan',
            ...(summary ? { summary } : {}),
            steps: steps.map((title) => ({ title, status: 'todo' })),
            status: 'pending',
            at: Date.now(),
          })
          return JSON.stringify({
            status: 'needs_approval',
            approval_id: a.id,
            next: '计划已经给用户看了。调用 await_approval 等用户同意；用户跳过就问问用户想怎么改。',
          })
        },
      }),
      defineTool({
        name: 'update_plan',
        description: '更新计划某一步的进度：开始做时标 doing，做完标 done，不做了标 skipped。',
        input: z.object({
          step: z.number().int().min(1).describe('第几步，从 1 开始'),
          status: z.enum(['doing', 'done', 'skipped']),
        }),
        run: ({ step, status }) => {
          const item = this.item
          if (item?.status !== 'approved') throw new CapabilityError('还没有用户同意的计划')
          if (step > item.steps.length)
            throw new CapabilityError(`计划只有 ${item.steps.length} 步`)
          const steps = item.steps.map((s, i) =>
            i === step - 1 ? { ...s, status: status as StepStatus } : s,
          )
          this.set({ ...item, steps })
          const left = steps.filter((s) => s.status === 'todo' || s.status === 'doing').length
          return left ? `好的，还剩 ${left} 步` : '计划的步骤都完成了'
        },
      }),
    ]
  }

  private set(item: PlanItem) {
    this.item = item
    this.onChange(item)
  }
}

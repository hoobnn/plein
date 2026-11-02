import type { CapabilityDefinition } from '@plein/capabilities'
import type { AgentApprovalMode, StoryboardBatchPlan } from '@plein/protocol'
import type { z } from 'zod'
import { newId } from '../ids'
import type { AgentChanges } from './changes'
import type { ServerContext } from './tools'

/** 规则模式下，一轮里超过这么多次运行就要问用户 */
export const RUN_LIMIT = 6

/** 需要用户点头的一次调用 */
export interface ApprovalRequest {
  /** 给用户看的一句话：要做什么、为什么要问 */
  reason: string
  /** 相关元素，确认卡片悬停时在画布上高亮 */
  ids: string[]
  /** 只保留展示依据；可执行 token 仅存在本轮批准闭包中。 */
  storyboardBatch?: Omit<StoryboardBatchPlan, 'token'>
}

type Cap = CapabilityDefinition<z.ZodObject, ServerContext>

/**
 * 确认策略（调度层，通用回退声明关不掉）：
 * - auto：全部直接执行；effect 不是 run / destructive 的直接放行；
 * - 声明了 approval 的能力提供确认的说法（两种模式同样生效），或用 exempt 显式放行；
 *   返回 null 等价于没声明，继续走下面的统一回退链；
 * - 统一回退：always 都问；rules 里破坏性的、插件能力花钱或删东西的问，其它不问。
 */
export function approvalFor(
  mode: AgentApprovalMode,
  cap: Cap,
  input: Record<string, unknown>,
  ctx: ServerContext,
  changes: AgentChanges,
): ApprovalRequest | null {
  if (mode === 'auto') return null
  const effect = typeof cap.effect === 'function' ? cap.effect(input, ctx) : cap.effect
  if (effect !== 'run' && effect !== 'destructive') return null
  const fallback = { reason: cap.title, ids: [] }
  if (cap.approval) {
    const declared = cap.approval(input, ctx, { mode, changes })
    if (declared) return 'exempt' in declared ? null : declared
    // 没给说法（null）不提前返回，继续走统一回退链
  }
  if (mode === 'always') return fallback
  if (effect === 'destructive') return fallback
  // 插件能力会花钱或删东西时，规则模式下也先问：宿主不知道它具体做什么
  if (cap.group === 'plugin') return fallback
  return null
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

export interface Approval extends ApprovalRequest {
  id: string
  tool: string
  status: ApprovalStatus
  /** 批准后执行原调用的结果（MCP 工具结果） */
  result?: Promise<unknown>
  /** 用户批准时选的项（修改方案的批准范围、选中的目标和跳过的步骤） */
  choice?: unknown
  run: (choice?: unknown) => Promise<unknown>
  /** 状态变化时唤醒等待者 */
  wake: Set<() => void>
}

/** 一个会话的确认单：批准即执行原调用，模型用 await_approval 取结果 */
export class Approvals {
  private items = new Map<string, Approval>()

  constructor(private onChange: (a: Approval) => void) {}

  create(
    tool: string,
    req: ApprovalRequest,
    run: (choice?: unknown) => Promise<unknown>,
  ): Approval {
    const a: Approval = {
      id: newId('apv'),
      tool,
      ...req,
      status: 'pending',
      run,
      wake: new Set(),
    }
    this.items.set(a.id, a)
    this.onChange(a)
    return a
  }

  get(id: string) {
    return this.items.get(id)
  }

  /** 用户点了允许 / 跳过（允许时可带上选的项）；不是待确认状态时返回 false */
  decide(id: string, allow: boolean, choice?: unknown): boolean {
    const a = this.items.get(id)
    if (a?.status !== 'pending') return false
    a.status = allow ? 'approved' : 'denied'
    if (allow && choice !== undefined) a.choice = choice
    if (allow) a.result = a.run(choice)
    this.settle(a)
    return true
  }

  /** 一轮结束：还没确认的作废 */
  expireAll() {
    for (const a of this.items.values()) {
      if (a.status !== 'pending') continue
      a.status = 'expired'
      this.settle(a)
    }
  }

  /** 某一张不再需要答复（CLI 撤回了请求） */
  expire(id: string) {
    const a = this.items.get(id)
    if (a?.status !== 'pending') return
    a.status = 'expired'
    this.settle(a)
  }

  /** 等用户决定，最多 seconds 秒；返回当时的确认单 */
  async wait(id: string, seconds: number): Promise<Approval | undefined> {
    const a = this.items.get(id)
    if (a?.status !== 'pending') return a
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        a.wake.delete(done)
        resolve()
      }
      const timer = setTimeout(done, seconds * 1000)
      a.wake.add(done)
    })
    return a
  }

  private settle(a: Approval) {
    for (const fn of [...a.wake]) fn()
    this.onChange(a)
  }
}

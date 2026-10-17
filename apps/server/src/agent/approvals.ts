import type { CapabilityDefinition } from '@plein/capabilities'
import type { AgentApprovalMode } from '@plein/protocol'
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
}

type Cap = CapabilityDefinition<z.ZodObject, ServerContext>

/**
 * 确认策略（调度层，不散进各个能力）：
 * - auto：全部直接执行；
 * - always：花钱（run）和破坏性（destructive）的都问；
 * - rules（默认）：视频生成、整组 / 上下游 / 分镜批量运行、删用户已有的东西、一轮里运行超过 RUN_LIMIT 次、
 *   插件能力花钱或删东西时才问。
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

  const name = (id: string) =>
    ctx.withDoc((doc) => {
      const el = doc.get(id)
      return el ? `「${el.name ?? el.kind}」` : id
    })

  if (cap.name === 'delete_elements') {
    const ids = (input.ids as string[]).filter((i) => !changes.createdThisTurn(i))
    if (!ids.length) return null
    return { reason: `删除你已有的 ${ids.length} 个元素`, ids }
  }
  if (cap.name === 'run_frame') {
    const frame = String(input.frame_id)
    return {
      reason: `整组运行 ${name(frame)}${input.video ? '（包括视频）' : ''}`,
      ids: [frame],
    }
  }
  if (cap.name === 'run_storyboard') {
    const board = String(input.id)
    const what =
      { image: '分镜图', video: '镜头视频', speech: '配音', sfx: '音效' }[String(input.role)] ?? ''
    return { reason: `批量生成${name(board)}的${what}`, ids: [board] }
  }
  // 智能体自己执行修改方案（没经过方案卡片）：要生成就先问，范围写进确认
  if (cap.name === 'apply_edit_plan')
    return {
      reason: input.scope === 'images' ? '按修改方案生成候选图' : '按修改方案执行全部生成步骤',
      ids: [],
    }
  if (cap.name === 'run_flow') {
    const node = String(input.id)
    return {
      reason: `${input.scope === 'upstream' ? '运行到' : '运行下游：'}${name(node)}`,
      ids: [node],
    }
  }
  if (cap.name === 'run_node') {
    const node = String(input.id)
    const capability = ctx.withDoc((doc) => {
      const type = doc.get(node)?.nodeType
      return type ? ctx.nodes.latest(type)?.def.capability : undefined
    })
    if (mode === 'always') return { reason: `运行 ${name(node)}`, ids: [node] }
    if (capability === 'video.generate')
      return { reason: `生成视频 ${name(node)}（较贵、较慢）`, ids: [node] }
    if (changes.runCount >= RUN_LIMIT)
      return {
        reason: `运行 ${name(node)}：这一轮已经运行了 ${changes.runCount} 次`,
        ids: [node],
      }
    return null
  }
  // 插件能力会花钱或删东西时，规则模式下也先问：宿主不知道它具体做什么
  if (mode === 'always' || cap.group === 'plugin') return { reason: cap.title, ids: [] }
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

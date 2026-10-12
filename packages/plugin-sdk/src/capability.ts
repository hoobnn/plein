import type { z } from 'zod'
import type { ExecutorContext } from './executor'
import { NAMESPACED_ID, vendorOf } from './ids'

/**
 * 插件贡献的能力：用户能做的一件事。登记后出现在 ⌘K 命令面板和智能体（内置 / Claude Code / Codex）的工具里。
 * 能力只在服务端运行；改画布要经 ctx.call 调 plein 自带的能力（get_canvas、create_node、run_node…），
 * 这样写入、撤销、确认和高亮都走同一套规则。
 */

/** 副作用等级：read 只读；edit 改画布；run 花钱或耗时（调模型、跑节点）；destructive 删东西 */
export type CapabilityEffect = 'read' | 'edit' | 'run' | 'destructive'

const RANK: Record<CapabilityEffect, number> = { read: 0, edit: 1, run: 2, destructive: 3 }

/** a 的副作用不超过 b */
export const effectWithin = (a: CapabilityEffect, b: CapabilityEffect) => RANK[a] <= RANK[b]

export interface PluginCapabilityContext {
  /** 调用发生在哪块画布 */
  canvasId: string
  /** 用户当前选中的元素（不知道时为空） */
  selection: string[]
  signal: AbortSignal
  /**
   * 调 plein 自带的能力，返回它的结构化结果。
   * 被调能力的副作用不能超过本能力声明的 effect（声明 edit 的能力不能运行节点）。
   */
  call(name: string, input?: Record<string, unknown>): Promise<unknown>
  providers: ExecutorContext['providers']
  /** 受清单 permissions.assets 约束 */
  assets: ExecutorContext['assets']
  log(message: string, data?: Record<string, unknown>): void
}

export interface PluginCapabilityDefinition<S extends z.ZodObject = z.ZodObject> {
  /** `vendor/name`，vendor 与插件相同且以字母开头；工具名为 `vendor__name`（- 和 . 换成 _） */
  id: string
  /** 给人看：⌘K、智能体面板 */
  title: string
  /** 给模型看：做什么、什么时候用 */
  description: string
  effect: CapabilityEffect
  input: S
  /**
   * 出现在 ⌘K 命令面板里：always 一直显示，selection 有选区时显示（选区经 ctx.selection 传入）。
   * 从面板调用时输入为 {}，所以输入的每个字段都要可选。不填则只给智能体用。
   */
  palette?: 'always' | 'selection'
  /** 返回字符串或可 JSON 序列化的对象；可预期的失败抛 Error，消息会原样告诉调用方 */
  run(ctx: PluginCapabilityContext, input: z.output<S>): unknown
}

export function definePluginCapability<S extends z.ZodObject>(
  def: PluginCapabilityDefinition<S>,
): PluginCapabilityDefinition {
  return def as unknown as PluginCapabilityDefinition
}

/** 能力 id 对应的工具名：`acme/word-count` → `acme__word_count` */
export function capabilityToolName(id: string) {
  return id.replace('/', '__').replace(/[-.]/g, '_')
}

/** 能力 id 是否可用：命名空间格式、vendor 以字母开头、工具名不超过 64 个字符 */
export function capabilityIdError(id: string): string | null {
  if (!NAMESPACED_ID.test(id)) return `能力 ${id} 的 id 格式应为 vendor/name`
  if (!/^[a-z]/.test(vendorOf(id))) return `能力 ${id} 的 vendor 要以字母开头`
  if (capabilityToolName(id).length > 64) return `能力 ${id} 的 id 太长`
  return null
}

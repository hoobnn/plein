import type { PleinDoc } from '@plein/doc'
import type { Capability, NodeDefinition, NodeDescriptor } from '@plein/plugin-sdk'
import type { z } from 'zod'

/**
 * 能力：用户能做的一件事，声明一次，界面、智能体（MCP / 内置）、插件都调用同一份。
 * 设计见 /mnt/project-files/plans/ai-native-capabilities-2026-10-12.md。
 */

/** 副作用等级：调度层据此决定直接执行、按规则确认还是先问用户 */
export type Effect = 'read' | 'edit' | 'run' | 'destructive'

/**
 * 运行位置：
 * - `doc`：只依赖文档和 CapabilityContext，前后端都能跑；
 * - `server`：要运行队列、资产文件、ffmpeg 等服务端设施；
 * - `client`：要界面（相机、选区、面板）。
 */
export type Where = 'doc' | 'server' | 'client'

/** 工具分组：内置智能体按组按需加载，⌘K 按组归类 */
export type Group = 'read' | 'edit' | 'run' | 'media' | 'story' | 'library' | 'project' | 'ui'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

const CONTENT = Symbol('plein:content')

/** 图文混排的结果（如看图）；普通结果直接返回对象，由适配层序列化 */
export interface ContentResult {
  [CONTENT]: true
  content: ContentBlock[]
}

export function content(blocks: ContentBlock[]): ContentResult {
  return { [CONTENT]: true, content: blocks }
}

export function isContent(v: unknown): v is ContentResult {
  return typeof v === 'object' && v !== null && CONTENT in v
}

/** 可预期的失败：消息原样告诉调用方（模型或用户），说明下一步怎么做 */
export class CapabilityError extends Error {}

export interface NodeTypeInfo {
  def: NodeDefinition
  descriptor: NodeDescriptor
  /** 有执行器（或是 inline 节点），能运行 */
  runnable: boolean
}

/** 节点类型目录：服务端查插件注册表，浏览器查 catalog */
export interface NodeCatalog {
  /** 某类型的最新版本 */
  latest(type: string): NodeTypeInfo | undefined
  /** 全部类型的最新版本 */
  all(): NodeTypeInfo[]
  /** 已启用、支持该模型能力的模型 */
  models(capability: Capability): Array<{ ref: string; title: string }>
}

export interface AssetMeta {
  kind: string
  mime?: string
  width?: number
  height?: number
  duration?: number
}

/** 能力运行时拿到的上下文；两端各实现一次 */
export interface CapabilityContext {
  /** 同步读写当前画布；写入带调用方的 origin（用户 / 某个智能体会话），撤销按它归属 */
  withDoc<T>(fn: (doc: PleinDoc) => T): T
  nodes: NodeCatalog
  assetMeta(id: string): AssetMeta | undefined
}

export interface CapabilityDefinition<
  S extends z.ZodObject = z.ZodObject,
  C extends CapabilityContext = CapabilityContext,
> {
  /** 全局唯一，只用小写字母、数字和下划线（MCP 工具名直接用它） */
  name: string
  /** 给人看：界面、⌘K、智能体面板 */
  title: string
  /** 给模型看：做什么、什么时候用、注意什么 */
  description: string
  group: Group
  where: Where
  /** 固定等级，或按这次调用的参数判定 */
  effect: Effect | ((input: z.output<S>, ctx: C) => Effect)
  input: S
  /** 返回结构化结果（字符串、对象或 content()）；失败抛 CapabilityError */
  run(ctx: C, input: z.output<S>): unknown
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/

export function defineCapability<
  S extends z.ZodObject,
  C extends CapabilityContext = CapabilityContext,
>(def: CapabilityDefinition<S, C>): CapabilityDefinition<z.ZodObject, C> {
  if (!NAME.test(def.name)) throw new Error(`能力名 ${def.name} 只能用小写字母、数字和下划线`)
  return def as unknown as CapabilityDefinition<z.ZodObject, C>
}

/** 绑定上下文类型的 defineCapability（服务端、客户端能力用）：capabilityFor<ServerContext>()({...}) */
export function capabilityFor<C extends CapabilityContext>() {
  return <S extends z.ZodObject>(def: CapabilityDefinition<S, C>) => defineCapability<S, C>(def)
}

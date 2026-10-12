import { z } from 'zod'
import { NAMESPACED_ID } from './ids'
import { PortSpec } from './ports'
import type { Capability } from './provider'

export const NodeCategory = z.enum(['input', 'text', 'image', 'video', 'audio', 'story', 'util'])
export type NodeCategory = z.infer<typeof NodeCategory>

/**
 * 节点声明：前后端共用的纯数据 + zod schema，不含执行逻辑。
 * 参数表单由 params 自动生成；可用 `.meta({ widget })` 提示控件：
 * `textarea`、`model`（按 capability 列出已启用平台的模型）、`asset`。
 */
export interface NodeDefinition<P extends z.ZodObject = z.ZodObject> {
  /** `vendor/name` */
  type: string
  /** 参数或端口不兼容地变化时 +1，旧版本节点通过 migrate 升级 */
  version: number
  title: string
  description?: string
  category: NodeCategory
  inputs: PortSpec[]
  outputs: PortSpec[]
  params: P
  /** 需要的模型能力；表单里的模型下拉框只列支持它的模型 */
  capability?: Capability
  /**
   * 怎么运行：
   * - `inline`：参数即结果，下游需要时就地计算（如文本节点）；
   * - `job`：排队运行，结果存进节点（调模型的节点，或合成视频这类耗时的处理）。
   * 默认有 capability 时为 job，否则为 inline。
   */
  execution?: NodeExecution
  /**
   * 运行成功后把输出写回参数（如分镜表要可编辑，结果需进参数）。
   * 返回要修改的参数键值；宿主以系统身份写入文档。
   */
  applyOutputs?(
    params: NodeParams<NodeDefinition<P>>,
    outputs: Record<string, Array<{ type: string; value?: unknown }>>,
  ): Record<string, unknown> | undefined
  /** 把 fromVersion 的参数升级到当前 version */
  migrate?(params: Record<string, unknown>, fromVersion: number): Record<string, unknown>
}

export type NodeParams<N extends NodeDefinition> = z.output<N['params']>

export type NodeExecution = 'inline' | 'job'

export function executionOf(def: Pick<NodeDefinition, 'execution' | 'capability'>): NodeExecution {
  return def.execution ?? (def.capability ? 'job' : 'inline')
}

/** 声明节点：校验基本约束，返回原对象（保留参数类型推断） */
export function defineNode<P extends z.ZodObject>(def: NodeDefinition<P>): NodeDefinition<P> {
  if (!NAMESPACED_ID.test(def.type)) throw new Error(`节点类型 ${def.type} 应为 vendor/name`)
  if (!Number.isInteger(def.version) || def.version < 1)
    throw new Error(`节点 ${def.type} 的版本应为正整数`)
  for (const [side, ports] of [
    ['inputs', def.inputs],
    ['outputs', def.outputs],
  ] as const) {
    const ids = new Set<string>()
    for (const p of ports) {
      PortSpec.parse(p)
      if (ids.has(p.id)) throw new Error(`节点 ${def.type} 的 ${side} 端口 ${p.id} 重复`)
      ids.add(p.id)
    }
  }
  // 所有参数必须有默认值或可选，这样新建节点不需要先填表
  const defaults = def.params.safeParse({})
  if (!defaults.success)
    throw new Error(`节点 ${def.type} 的参数需要都有默认值：${defaults.error.message}`)
  return def
}

/** 节点的可序列化描述，供前端生成菜单和表单 */
export interface NodeDescriptor {
  type: string
  version: number
  title: string
  description?: string
  category: NodeCategory
  inputs: PortSpec[]
  outputs: PortSpec[]
  capability?: Capability
  execution: NodeExecution
  /** 参数的 JSON Schema（含 meta 提示） */
  paramsSchema: Record<string, unknown>
  defaults: Record<string, unknown>
  plugin: string
}

export function describeNode(def: NodeDefinition, plugin: string): NodeDescriptor {
  return {
    type: def.type,
    version: def.version,
    title: def.title,
    description: def.description,
    category: def.category,
    inputs: def.inputs,
    outputs: def.outputs,
    capability: def.capability,
    execution: executionOf(def),
    paramsSchema: z.toJSONSchema(def.params, { io: 'input', unrepresentable: 'any' }) as Record<
      string,
      unknown
    >,
    defaults: def.params.parse({}) as Record<string, unknown>,
    plugin,
  }
}

/**
 * 读取节点参数：按版本迁移后用 schema 校验并补默认值。
 * 来自文档的参数可能是旧版本、被并发编辑或手改过，不能直接信任。
 */
export function resolveParams<N extends NodeDefinition>(
  def: N,
  params: Record<string, unknown> | undefined,
  fromVersion = def.version,
): NodeParams<N> {
  let p = params ?? {}
  if (fromVersion > def.version)
    throw new Error(`节点 ${def.type} 的版本 ${fromVersion} 高于已安装的 ${def.version}`)
  if (fromVersion < def.version) {
    if (!def.migrate) throw new Error(`节点 ${def.type} 不能从版本 ${fromVersion} 升级`)
    p = def.migrate(p, fromVersion)
  }
  return def.params.parse(p) as NodeParams<N>
}

import type { MediaService } from './media'
import type { NodeDefinition, NodeParams } from './node'
import type { AssetRef, PortValue } from './ports'
import type {
  Capability,
  CapabilityInput,
  ModelSpec,
  ProviderOutput,
  ProviderUsage,
} from './provider'

/** 执行器的输出：按输出端口 id 给值，一个端口可以有多个候选 */
export type NodeOutputs = Record<string, PortValue[]>

export interface ProviderCallResult {
  outputs: ProviderOutput[]
  /** 文件类输出已由宿主存入资产库 */
  assets: AssetRef[]
  usage?: ProviderUsage
}

/**
 * 执行器拿到的环境。调用模型只能经过 providers.call：
 * 宿主负责选 Provider、注入密钥、限流、轮询异步任务、取消和把结果文件存入资产库。
 */
export interface ExecutorContext<P = Record<string, unknown>> {
  /** 已迁移、校验并补全默认值的参数 */
  params: P
  /** 按输入端口 id 收集的上游值 */
  inputs: Record<string, PortValue[]>
  signal: AbortSignal
  progress(fraction: number, message?: string): void
  log(message: string, data?: Record<string, unknown>): void
  providers: {
    call<C extends Capability>(
      capability: C,
      model: string,
      input: CapabilityInput<C>,
    ): Promise<ProviderCallResult>
    /** 已启用平台中支持该能力的模型，model 字段为 `provider:model` 引用 */
    models(capability: Capability): Array<ModelSpec & { ref: string; provider: string }>
  }
  assets: {
    /** 需要清单 permissions.assets 至少为 write */
    put(file: { data: Uint8Array; mime: string; name?: string }): Promise<AssetRef>
    /** 需要清单 permissions.assets 至少为 read */
    read(ref: AssetRef): Promise<{ data: Uint8Array; mime: string }>
  }
  /** 需要清单 permissions.media */
  media: MediaService
}

/** 节点执行器：只在服务端运行，按节点 `type@version` 注册 */
export interface ExecutorDefinition<N extends NodeDefinition = NodeDefinition> {
  node: N
  run(ctx: ExecutorContext<NodeParams<N>>): Promise<NodeOutputs>
}

export function defineExecutor<N extends NodeDefinition>(
  node: N,
  run: (ctx: ExecutorContext<NodeParams<N>>) => Promise<NodeOutputs>,
): ExecutorDefinition<N> {
  return { node, run }
}

/** 取某个输入端口的第一段文本（多段时用换行拼接） */
export function inputText(inputs: Record<string, PortValue[]>, port: string): string | undefined {
  const texts = (inputs[port] ?? []).flatMap((v) =>
    v.type === 'text' ? [v.text] : v.type === 'json' ? [JSON.stringify(v.value)] : [],
  )
  return texts.length ? texts.join('\n') : undefined
}

/** 取某个输入端口的资产引用 */
export function inputAssets(inputs: Record<string, PortValue[]>, port: string): AssetRef[] {
  return (inputs[port] ?? []).flatMap((v) =>
    v.type === 'image' || v.type === 'video' || v.type === 'audio' ? [v] : [],
  )
}

import type { PluginCapabilityDefinition } from './capability'
import type {
  ElementTypeDefinition,
  PromptPresetDefinition,
  TemplateDefinition,
} from './contributions'
import type { ExecutorDefinition } from './executor'
import { PluginManifest, type PluginManifestInput } from './manifest'
import type { NodeDefinition } from './node'
import type { ProviderDefinition } from './provider'

/**
 * 插件的共用部分：清单 + 声明，前后端都可以导入（不含服务端代码）。
 */
export interface PluginDefinition {
  manifest: PluginManifest
  nodes: NodeDefinition[]
  templates: TemplateDefinition[]
  elements: ElementTypeDefinition[]
  prompts: PromptPresetDefinition[]
}

export function definePlugin(input: {
  manifest: PluginManifestInput
  // biome-ignore lint/suspicious/noExplicitAny: 各节点的参数类型不同
  nodes?: NodeDefinition<any>[]
  templates?: TemplateDefinition[]
  elements?: ElementTypeDefinition[]
  prompts?: PromptPresetDefinition[]
}): PluginDefinition {
  return {
    manifest: PluginManifest.parse(input.manifest),
    nodes: input.nodes ?? [],
    templates: input.templates ?? [],
    elements: input.elements ?? [],
    prompts: input.prompts ?? [],
  }
}

/**
 * 插件的服务端部分：Provider、节点执行器和能力。
 * 内置插件在主进程加载；第三方插件以后在子进程加载，通过 stdio JSON-RPC 与宿主通信，接口不变。
 */
export interface ServerPluginDefinition {
  plugin: PluginDefinition
  // biome-ignore lint/suspicious/noExplicitAny: 各 Provider 的设置类型不同
  providers: ProviderDefinition<any>[]
  // biome-ignore lint/suspicious/noExplicitAny: 各执行器对应的节点不同
  executors: ExecutorDefinition<any>[]
  capabilities: PluginCapabilityDefinition[]
}

export function defineServerPlugin(
  plugin: PluginDefinition,
  parts: {
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    providers?: ProviderDefinition<any>[]
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    executors?: ExecutorDefinition<any>[]
    capabilities?: PluginCapabilityDefinition[]
  },
): ServerPluginDefinition {
  return {
    plugin,
    providers: parts.providers ?? [],
    executors: parts.executors ?? [],
    capabilities: parts.capabilities ?? [],
  }
}

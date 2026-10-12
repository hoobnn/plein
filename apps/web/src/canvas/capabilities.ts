import {
  type CapabilityContext,
  type CapabilityDefinition,
  CapabilityRegistry,
  editCapabilities,
  storyCapabilities,
} from '@plein/capabilities'
import type { Engine } from '@plein/canvas-core'
import type { NodeDefinition } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { findNode } from './nodes'

/**
 * 浏览器里直接执行的文档能力：与智能体用的是同一套定义，写入走本地 origin，进用户自己的撤销栈。
 * 只放不需要服务端的（编辑、剧情）；运行、媒体加工仍然走原来的入口。
 */
export const localCapabilities = new CapabilityRegistry<CapabilityContext>([
  ...(editCapabilities as never[]),
  ...(storyCapabilities as never[]),
])

export type LocalCapability = CapabilityDefinition

/** catalog 里只有节点声明（没有 zod 定义）：本地能力只用声明，def 只填标识字段 */
function infoOf(node: Catalog['nodes'][number]) {
  return {
    def: {
      type: node.type,
      version: node.version,
      title: node.title,
      capability: node.capability,
    } as NodeDefinition,
    descriptor: node,
    runnable: node.executable,
  }
}

export function localContext(engine: Engine, catalog: Catalog | null): CapabilityContext {
  return {
    withDoc: (fn) => fn(engine.doc),
    nodes: {
      latest: (type) => {
        const node = findNode(catalog, type)
        return node && infoOf(node)
      },
      all: () => (catalog?.nodes ?? []).filter((n) => findNode(catalog, n.type) === n).map(infoOf),
      models: (capability) =>
        (catalog?.providers ?? []).flatMap((p) =>
          p.enabled
            ? p.models
                .filter((m) => m.capabilities.includes(capability))
                .map((m) => ({ ref: `${p.id}:${m.id}`, title: m.title ?? m.id }))
            : [],
        ),
      prompts: () => catalog?.prompts ?? [],
    },
    assetMeta: () => undefined,
  }
}

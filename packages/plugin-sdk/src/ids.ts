import { z } from 'zod'

/**
 * 插件 API 版本，与 package.json 的 version 一致；插件清单的 engines.plein 用它做兼容判断。
 * 0.1.0 起按语义化版本演进：0.x 期间不兼容的改动升次版本号（0.2.0），兼容的新增和修复升修订号
 */
export const PLUGIN_API_VERSION = '0.1.1'

/**
 * 命名空间标识：`vendor/name`，全小写。
 * 插件 id 和它贡献的节点类型、Provider、模板、元素类型都用这个格式，
 * 且贡献项的 vendor 必须与插件 id 的 vendor 相同。
 */
export const NAMESPACED_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/
export const NamespacedId = z.string().regex(NAMESPACED_ID, '格式应为 vendor/name，全小写')

export const vendorOf = (id: string) => id.slice(0, id.indexOf('/'))

/** 节点类型带版本：`vendor/name@1` */
export const nodeKey = (type: string, version: number) => `${type}@${version}`

export function parseNodeKey(key: string): { type: string; version: number } | null {
  const at = key.lastIndexOf('@')
  if (at < 0) return null
  const version = Number(key.slice(at + 1))
  const type = key.slice(0, at)
  return Number.isInteger(version) && version > 0 && NAMESPACED_ID.test(type)
    ? { type, version }
    : null
}

/**
 * 模型引用：`<provider id>:<model id>`，例如 `plein/mock:echo-chat`。
 * 节点参数里只存这个字符串，便于协作合并。
 */
export const modelRef = (provider: string, model: string) => `${provider}:${model}`

export function parseModelRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf(':')
  if (i < 0) return null
  const provider = ref.slice(0, i)
  const model = ref.slice(i + 1)
  return NAMESPACED_ID.test(provider) && model ? { provider, model } : null
}

import { parseModelRef } from '@plein/plugin-sdk'
import type { DependencyStatus } from '@plein/protocol'
import type { PluginHost } from '../plugins/host'

/**
 * 项目包声明的外部依赖，在本机是否还可用。
 * 只看平台是否启用与节点版本，与导入结果无关。
 */

/** 一个模型依赖在本机的状态 */
export function modelStatus(host: PluginHost, ref: string): DependencyStatus {
  const parsed = parseModelRef(ref)
  const entry = parsed && host.registry.providers.get(parsed.provider)
  if (!parsed || !entry || !entry.def.models.some((m) => m.id === parsed.model)) return 'missing'
  return host.configs.get(parsed.provider).enabled ? 'ok' : 'disabled'
}

/** 一个音色依赖在本机的状态 */
export function voiceStatus(host: PluginHost, provider: string): DependencyStatus {
  if (!provider) return 'unverified'
  if (!host.registry.providers.has(provider)) return 'missing'
  if (!host.configs.get(provider).enabled) return 'disabled'
  // 复刻 / 设计的音色属于平台账户，只能在用的时候知道还在不在
  return 'unverified'
}

/** 一个节点类型依赖在本机的状态 */
export function nodeStatus(host: PluginHost, type: string, version: number): DependencyStatus {
  const latest = host.registry.latestNode(type)
  if (!latest) return 'missing'
  return latest.def.version < version ? 'outdated' : 'ok'
}

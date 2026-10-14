import { type PleinDoc, setParams, SYSTEM_ORIGIN } from '@plein/doc'
import { describeNode, modelParamOf } from '@plein/plugin-sdk'
import type { PluginHost } from '../plugins/host'

/**
 * 以前模型留空的节点运行时由服务端自动选模型，现在必须选定：打开画布时把空的模型补成该能力的默认模型。
 * 没有默认模型的留空，节点上提示去选。返回补上的节点数
 */
export function fillModels(doc: PleinDoc, host: PluginHost): number {
  const keys = new Map<string, string | undefined>()
  const patches: Array<[string, Record<string, string>]> = []
  for (const el of doc.elements()) {
    if (el.kind !== 'node' || !el.nodeType) continue
    const entry = host.registry.latestNode(el.nodeType)
    const cap = entry?.def.capability
    if (!entry || !cap) continue
    if (!keys.has(el.nodeType))
      keys.set(el.nodeType, modelParamOf(describeNode(entry.def, entry.plugin)))
    const key = keys.get(el.nodeType)
    if (!key || el.params?.[key]) continue
    const ref = host.defaultModel(cap)
    if (ref) patches.push([el.id, { [key]: ref }])
  }
  if (patches.length)
    doc.ydoc.transact(() => {
      for (const [id, p] of patches) setParams(doc, id, p)
    }, SYSTEM_ORIGIN)
  return patches.length
}

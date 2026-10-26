import { expandPluginTemplate } from '@plein/capabilities'
import type { PleinDoc } from '@plein/doc'
import type { Catalog } from '@plein/protocol'
import { nodeElement } from './nodes'

export type PluginTemplate = Catalog['templates'][number]

/** 界面与 Agent 共用模板预检与引用规则，界面保留自己的初始卡片尺寸。 */
export function pluginTemplateData(
  catalog: Catalog,
  template: PluginTemplate,
  destination?: PleinDoc,
) {
  return expandPluginTemplate(catalog, template, destination, (node, params) =>
    nodeElement(node as Catalog['nodes'][number], params),
  )
}

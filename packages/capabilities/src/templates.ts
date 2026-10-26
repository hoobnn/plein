import {
  createDoc,
  createElement,
  connect,
  exportElements,
  type ClipboardData,
  type PleinDoc,
} from '@plein/doc'
import type { NodeDescriptor, TemplateDefinition } from '@plein/plugin-sdk'
import { nodeElementOf } from './story/nodes'
import { parseNodeDescriptorParams } from '@plein/plugin-sdk'
import { findMentions, mentionName, type MentionTarget } from '@plein/nodes'

export type PluginTemplate = TemplateDefinition & { plugin: string }
export interface TemplateCatalog {
  plugins: Array<{ id: string; status: string }>
  nodes: Array<NodeDescriptor & { executable?: boolean; execution?: string }>
}

/** 在独立文档里预检并展开。任何依赖/连线错误都不会给当前画布留下半份模板。 */
export function expandPluginTemplate(
  catalog: TemplateCatalog,
  template: PluginTemplate,
  destination?: PleinDoc,
  makeNode: (
    node: TemplateCatalog['nodes'][number],
    params: Record<string, unknown>,
  ) => ReturnType<typeof nodeElementOf> = nodeElementOf,
): ClipboardData {
  if (!template.nodes.length || template.nodes.length > 500 || template.edges.length > 2000)
    throw new Error('模板应包含 1–500 个节点和至多 2000 条连线')
  const plugin = catalog.plugins.find((p) => p.id === template.plugin)
  if (!plugin || plugin.status !== 'active')
    throw new Error('模板所属插件未加载，请重新打开添加菜单')
  const keys = new Set<string>()
  const nodes = template.nodes.map((item) => {
    if (!item.key || keys.has(item.key)) throw new Error('模板节点标识为空或重复')
    keys.add(item.key)
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) throw new Error('模板节点位置不合法')
    const node = catalog.nodes.find((n) => n.type === item.type && n.version === item.version)
    if (!node) throw new Error(`模板需要未安装的节点 ${item.type}@${item.version}`)
    if (node.execution !== 'inline' && !node.executable)
      throw new Error(`模板节点 ${node.title} 缺少执行器`)
    const params = structuredClone(parseNodeDescriptorParams(node, item.params))
    return { item, input: makeNode(node, params) }
  })
  const minX = Math.min(...nodes.map(({ item }) => item.x))
  const minY = Math.min(...nodes.map(({ item }) => item.y))
  const padding = 32
  const width = Math.max(...nodes.map(({ item, input }) => item.x + input.w)) - minX
  const height = Math.max(...nodes.map(({ item, input }) => item.y + input.h)) - minY
  if (!Number.isFinite(width + padding * 2) || !Number.isFinite(height + padding * 2))
    throw new Error('模板节点位置超出可用范围')
  const doc = createDoc(undefined, { schedule: () => {} })
  try {
    const frame = createElement(doc, {
      kind: 'frame',
      name: template.title,
      x: 0,
      y: 0,
      w: width + padding * 2,
      h: height + padding * 2,
    })
    const ids = new Map(
      nodes.map(({ item, input }) => [
        item.key,
        createElement(doc, {
          ...input,
          name: item.title ?? input.name,
          parentId: frame,
          x: item.x - minX + padding,
          y: item.y - minY + padding,
        }),
      ]),
    )
    const targets = new Map<string, number>()
    const outgoing = new Map<string, string[]>()
    const indegree = new Map([...keys].map((key) => [key, 0]))
    for (const edge of template.edges) {
      const source = ids.get(edge.from[0]),
        target = ids.get(edge.to[0])
      if (!source || !target) throw new Error('模板连线引用了不存在的节点')
      const port = doc.get(target)?.ports?.inputs.find((p) => p.id === edge.to[1])
      const address = JSON.stringify(edge.to)
      const count = (targets.get(address) ?? 0) + 1
      targets.set(address, count)
      if (count > 1 && !port?.multiple) throw new Error('模板向单输入端口连接了多个来源')
      if (!connect(doc, [source, edge.from[1]], [target, edge.to[1]]))
        throw new Error('模板连线的端口不存在、类型不匹配或重复')
      outgoing.set(edge.from[0], [...(outgoing.get(edge.from[0]) ?? []), edge.to[0]])
      indegree.set(edge.to[0], indegree.get(edge.to[0])! + 1)
    }
    const queue = [...keys].filter((key) => indegree.get(key) === 0)
    for (let i = 0; i < queue.length; i++) {
      for (const target of outgoing.get(queue[i]!) ?? []) {
        indegree.set(target, indegree.get(target)! - 1)
        if (indegree.get(target) === 0) queue.push(target)
      }
    }
    if (queue.length !== keys.size) throw new Error('模板连线包含循环，无法执行')
    const mentionTargets = (source: PleinDoc): MentionTarget[] =>
      [...source.elements()].flatMap((el) => {
        const name = mentionName(el)
        return name ? [{ id: el.id, name }] : []
      })
    const internal = mentionTargets(doc)
    const external = destination ? mentionTargets(destination) : []
    const checkReferences = (value: unknown): void => {
      if (typeof value === 'string') {
        const refs = findMentions(value, internal)
        // 模板没有稳定的元素 ID；同名 #序号 会依赖临时随机 ID 的排序，不能代表作者意图。
        if (refs.some((ref) => !ref.id || ref.total > 1))
          throw new Error('模板内资产引用不明确，请给资产使用不同名称')
        // 按粘贴后的完整名称集合重新解析，防止外部更长名称抢占同一起点的内部引用。
        // 同名资产由 referenceClipboard 按已确定的内部身份重映射；仅起点相同不足以证明身份相同。
        const combined = findMentions(value, [...internal, ...external])
        if (
          combined.some(
            (ref) =>
              !refs.some(
                (own) =>
                  own.id && own.start === ref.start && own.end === ref.end && own.name === ref.name,
              ),
          )
        )
          throw new Error('模板引用会匹配当前画布的外部资产，请先在模板中补齐或澄清参考名称')
      } else if (value && typeof value === 'object') {
        for (const nested of Object.values(value)) checkReferences(nested)
      }
    }
    for (const element of doc.elements()) checkReferences(element.params)
    return exportElements(doc, [frame])
  } finally {
    doc.destroy()
  }
}

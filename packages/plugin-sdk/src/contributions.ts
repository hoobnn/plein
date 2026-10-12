import type { z } from 'zod'
import { NAMESPACED_ID } from './ids'

/** 模板：预连好的节点组与提示词，纯数据 */
export interface TemplateDefinition {
  id: string
  title: string
  description?: string
  nodes: Array<{
    /** 模板内引用用的 key */
    key: string
    type: string
    version: number
    title?: string
    params?: Record<string, unknown>
    /** 相对模板左上角的位置 */
    x: number
    y: number
  }>
  edges: Array<{ from: [key: string, port: string]; to: [key: string, port: string] }>
}

export function defineTemplate(def: TemplateDefinition): TemplateDefinition {
  if (!NAMESPACED_ID.test(def.id)) throw new Error(`模板 id ${def.id} 应为 vendor/name`)
  const keys = new Set(def.nodes.map((n) => n.key))
  if (keys.size !== def.nodes.length) throw new Error(`模板 ${def.id} 的节点 key 重复`)
  for (const e of def.edges) {
    if (!keys.has(e.from[0]) || !keys.has(e.to[0]))
      throw new Error(`模板 ${def.id} 的连线引用了不存在的节点`)
  }
  return def
}

/**
 * 自定义元素类型：文档里存为 `kind: 'custom'` + `customType`。
 * 0.1.0 只有声明（标题、默认尺寸、数据 schema），渲染器以后用沙箱 iframe 提供；
 * 未安装对应插件时画布显示占位卡片，数据不丢。
 */
export interface ElementTypeDefinition<D extends z.ZodObject = z.ZodObject> {
  type: string
  title: string
  description?: string
  defaultSize: { w: number; h: number }
  data: D
}

export function defineElementType<D extends z.ZodObject>(
  def: ElementTypeDefinition<D>,
): ElementTypeDefinition<D> {
  if (!NAMESPACED_ID.test(def.type)) throw new Error(`元素类型 ${def.type} 应为 vendor/name`)
  return def
}

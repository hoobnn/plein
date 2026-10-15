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
 * 提示词预设：提示词框行首输入 `/` 选用，插入模板文本，可顺带设置参数（如张数、画幅）。
 * 模板里的 `【…】` 是待填的占位，插入后选中第一个，直接打字替换。
 */
export interface PromptPresetDefinition {
  id: string
  title: string
  description?: string
  template: string
  /** 适用的节点能力（如 image.generate）或节点类型（如 plein/llm）；不填表示所有带提示词的节点 */
  appliesTo?: string[]
  /** 选用时一并设置的参数；节点没有的参数忽略 */
  params?: Record<string, unknown>
  /**
   * 镜头 / 风格条上的一个选项（运镜、景别、角度、光影、风格）：template 是插进提示词的那一小段，
   * 同一栏单选；不出现在行首 / 预设菜单里。只改写提示词，不是平台的摄影控制参数
   */
  slot?: ShotSlot
}

export const SHOT_SLOTS = [
  'camera.move',
  'camera.shot',
  'camera.angle',
  'camera.light',
  'style',
] as const
export type ShotSlot = (typeof SHOT_SLOTS)[number]

export function definePromptPreset(def: PromptPresetDefinition): PromptPresetDefinition {
  if (!NAMESPACED_ID.test(def.id)) throw new Error(`提示词预设 id ${def.id} 应为 vendor/name`)
  if (!def.template.trim()) throw new Error(`提示词预设 ${def.id} 的模板为空`)
  if (def.slot && !SHOT_SLOTS.includes(def.slot))
    throw new Error(`提示词预设 ${def.id} 的 slot ${def.slot} 不认识`)
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

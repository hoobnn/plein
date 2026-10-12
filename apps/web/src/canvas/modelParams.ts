import type { ModelInfo, ModelLimits } from '@plein/plugin-sdk'
import type { Catalog } from '@plein/protocol'
import { aspectKey, type FieldSchema, fieldsOf, type NodeInfo, type Upstream } from './nodes'

/**
 * 按所选模型的声明处理节点参数：收窄表单选项、换模型时校正取值、提交前检查。
 * 模型怎么声明见 plugin-sdk 的 ModelLimits / ModelSpec.options。
 */

export interface SelectedModel {
  /** 节点里存的引用；自动选择时为空 */
  ref: string
  info: ModelInfo & { ref: string }
}

/** 节点的模型参数名 */
export function modelKey(node: NodeInfo) {
  return fieldsOf(node).find(([, f]) => f.widget === 'model')?.[0]
}

/** 节点参数里选中的模型；“自动”按服务端的规则取第一个已启用平台里第一个支持该能力的模型 */
export function selectedModel(
  catalog: Catalog | null,
  node: NodeInfo,
  params: Record<string, unknown> | undefined,
): SelectedModel | undefined {
  const key = modelKey(node)
  if (!key) return undefined
  const ref = String(params?.[key] ?? '')
  const models = (catalog?.providers ?? [])
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.models
        .filter((m) => !node.capability || m.capabilities.includes(node.capability))
        .map((m) => ({ ...m, ref: `${p.id}:${m.id}` })),
    )
  const info = ref ? models.find((m) => m.ref === ref) : models[0]
  return info ? { ref, info } : undefined
}

const NONE: ModelLimits = {}

/** 按模型约束改写字段：选项收窄、范围取交集，不支持的项去掉；专属参数单独渲染，这里也去掉 */
export function constrainFields(
  node: NodeInfo,
  fields: Array<[string, FieldSchema]>,
  limits: ModelLimits = NONE,
): Array<[string, FieldSchema]> {
  const ak = aspectKey(node)
  return fields.flatMap(([k, f]): Array<[string, FieldSchema]> => {
    if (f.widget === 'modelOptions') return []
    if (f.widget === 'resolution')
      return limits.resolutions?.length ? [[k, { ...f, enum: ['', ...limits.resolutions] }]] : []
    if (k === ak && f.enum && limits.aspectRatios) {
      const allowed = f.enum.filter((o) => limits.aspectRatios!.includes(String(o)))
      return [[k, { ...f, enum: allowed.length ? allowed : f.enum }]]
    }
    if (k === 'duration' && limits.duration)
      return [
        [
          k,
          {
            ...f,
            minimum: Math.max(f.minimum ?? limits.duration.min, limits.duration.min),
            maximum: Math.min(f.maximum ?? limits.duration.max, limits.duration.max),
          },
        ],
      ]
    if (k === 'count' && limits.count) {
      const maximum = Math.min(f.maximum ?? limits.count.max, limits.count.max)
      return maximum <= (f.minimum ?? 1) ? [] : [[k, { ...f, maximum }]]
    }
    if (k === 'seed' && limits.seed === false) return []
    return [[k, f]]
  })
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/**
 * 换到新模型时需要改的参数和对应说明：分辨率不支持改回默认，画幅换成第一个支持的，
 * 时长、张数夹到范围内。种子留着（隐藏且不会传给平台），换回来还在。
 */
export function adaptToModel(
  node: NodeInfo,
  params: Record<string, unknown>,
  model: SelectedModel['info'] | undefined,
): { patch: Record<string, unknown>; notes: string[] } {
  const limits = model?.limits ?? NONE
  const patch: Record<string, unknown> = {}
  const notes: string[] = []
  const name = model?.title ?? '所选模型'
  for (const [k, f] of fieldsOf(node)) {
    const v = params[k] ?? f.default
    if (f.widget === 'resolution' && v && !limits.resolutions?.includes(String(v))) {
      patch[k] = ''
      notes.push(`分辨率已改回默认（${name} 不支持 ${String(v)}）`)
    } else if (k === aspectKey(node) && limits.aspectRatios && v !== undefined) {
      if (!limits.aspectRatios.includes(String(v))) {
        const next = (f.enum ?? []).find((o) => limits.aspectRatios!.includes(String(o)))
        if (next !== undefined) {
          patch[k] = next
          notes.push(`画幅已从 ${String(v)} 改为 ${String(next)}（${name} 不支持 ${String(v)}）`)
        }
      }
    } else if (k === 'duration' && limits.duration && typeof v === 'number') {
      const n = clamp(v, limits.duration.min, limits.duration.max)
      if (n !== v) {
        patch[k] = n
        notes.push(
          `时长已从 ${v} 秒改为 ${n} 秒（${name} 支持 ${limits.duration.min}–${limits.duration.max} 秒）`,
        )
      }
    } else if (k === 'count' && limits.count && typeof v === 'number' && v > limits.count.max) {
      patch[k] = limits.count.max
      notes.push(`张数已改为 ${limits.count.max}（${name} 最多 ${limits.count.max} 张）`)
    }
  }
  return { patch, notes }
}

/** 提交前按模型约束检查，返回第一条问题 */
export function modelProblem(
  node: NodeInfo,
  params: Record<string, unknown>,
  model: SelectedModel['info'] | undefined,
  ups: Map<string, Upstream[]>,
): string | null {
  if (!model) return null
  const { patch } = adaptToModel(node, params, model)
  const limits = model.limits ?? NONE
  const name = model.title
  for (const [k, f] of fieldsOf(node)) {
    if (!(k in patch)) continue
    const v = params[k] ?? f.default
    if (f.widget === 'resolution') return `${name} 不支持分辨率 ${String(v)}`
    if (k === 'duration')
      return `${name} 的时长须为 ${limits.duration!.min}–${limits.duration!.max} 秒`
    if (k === 'count') return `${name} 一次最多生成 ${limits.count!.max} 张`
    return `${name} 不支持${f.title ?? k} ${String(v)}`
  }
  const refs = ups.get('references')?.length ?? 0
  if (limits.references && refs > limits.references.max)
    return `${name} 最多支持 ${limits.references.max} 张参考图，现在连了 ${refs} 张`
  return null
}

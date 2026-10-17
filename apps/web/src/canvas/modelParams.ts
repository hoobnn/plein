import type { ModelInfo, ModelLimits } from '@plein/plugin-sdk'
import { type VideoMode, videoModeProblem } from '@plein/nodes'
import type { Catalog } from '@plein/protocol'
import {
  aspectKey,
  aspectLabel,
  type FieldSchema,
  fieldsOf,
  type NodeInfo,
  type Upstream,
} from './nodes'

/**
 * 按所选模型的声明处理节点参数：收窄表单选项、换模型时校正取值、提交前检查。
 * 模型怎么声明见 plugin-sdk 的 ModelLimits / ModelSpec.options。
 */

export interface SelectedModel {
  /** 节点里存的引用 */
  ref: string
  info: ModelInfo & { ref: string }
}

/** 节点的模型参数名 */
function modelKey(node: NodeInfo) {
  return fieldsOf(node).find(([, f]) => f.widget === 'model')?.[0]
}

/** 节点参数里选中的模型；没选或所选平台没启用时为空 */
export function selectedModel(
  catalog: Catalog | null,
  node: NodeInfo,
  params: Record<string, unknown> | undefined,
): SelectedModel | undefined {
  const key = modelKey(node)
  if (!key) return undefined
  const ref = String(params?.[key] ?? '')
  if (!ref) return undefined
  const models = (catalog?.providers ?? [])
    .filter((p) => p.enabled)
    .flatMap((p) =>
      p.models
        .filter((m) => !node.capability || m.capabilities.includes(node.capability))
        .map((m) => ({ ...m, ref: `${p.id}:${m.id}` })),
    )
  const info = models.find((m) => m.ref === ref)
  return info ? { ref, info } : undefined
}

const NONE: ModelLimits = {}

/** 有范围约束的数值参数及其单位 */
const RANGED = { duration: '秒', speed: '倍' } as const
type Ranged = keyof typeof RANGED
const isRanged = (k: string): k is Ranged => k in RANGED
/** 模型可以声明为不支持（false）的参数 */
const TOGGLED = ['seed', 'duration', 'speed', 'instruction', 'audio'] as const
const unsupported = (k: string, limits: ModelLimits) =>
  (TOGGLED as readonly string[]).includes(k) && limits[k as (typeof TOGGLED)[number]] === false
const rangeOf = (k: Ranged, limits: ModelLimits) => {
  const r = limits[k]
  return r ? r : undefined
}

/** 按模型约束改写字段：选项收窄、范围取交集，不支持的项去掉；专属参数单独渲染，这里也去掉 */
export function constrainFields(
  node: NodeInfo,
  fields: Array<[string, FieldSchema]>,
  limits: ModelLimits = NONE,
  params?: Record<string, unknown>,
): Array<[string, FieldSchema]> {
  const ak = aspectKey(node)
  return fields.flatMap(([k, f]): Array<[string, FieldSchema]> => {
    if (f.widget === 'modelOptions') return []
    if (node.capability === 'image.process' && params?.operation) {
      if (k === 'scale' && params.operation !== 'upscale') return []
      if (['top', 'bottom', 'left', 'right'].includes(k) && params.operation !== 'outpaint')
        return []
    }
    if (k === 'operation' && node.capability === 'image.process' && limits.imageOperations)
      return [[k, { ...f, enum: limits.imageOperations }]]
    if (f.widget === 'resolution')
      return limits.resolutions?.length ? [[k, { ...f, enum: ['', ...limits.resolutions] }]] : []
    if (k === ak && f.enum) {
      // 没声明画幅的模型不给「智能」：auto 要模型明确支持
      const allowed = f.enum.filter((o) =>
        limits.aspectRatios ? limits.aspectRatios.includes(String(o)) : o !== 'auto',
      )
      return [[k, { ...f, enum: allowed.length ? allowed : f.enum }]]
    }
    if (unsupported(k, limits)) return []
    const range = isRanged(k) ? rangeOf(k, limits) : undefined
    if (range)
      return [
        [
          k,
          {
            ...f,
            minimum: Math.max(f.minimum ?? range.min, range.min),
            maximum: Math.min(f.maximum ?? range.max, range.max),
          },
        ],
      ]
    if (k === 'count' && limits.count) {
      const maximum = Math.min(f.maximum ?? limits.count.max, limits.count.max)
      return maximum <= (f.minimum ?? 1) ? [] : [[k, { ...f, maximum }]]
    }
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
    if (
      k === 'operation' &&
      node.capability === 'image.process' &&
      limits.imageOperations?.length &&
      !limits.imageOperations.includes(v as 'upscale' | 'outpaint' | 'cutout')
    ) {
      patch[k] = limits.imageOperations[0]
      notes.push('已切换为所选模型支持的精修操作')
    } else if (f.widget === 'resolution' && v && !limits.resolutions?.includes(String(v))) {
      patch[k] = ''
      notes.push(`分辨率已改回默认（${name} 不支持 ${String(v)}）`)
    } else if (k === aspectKey(node) && v !== undefined) {
      const supported = limits.aspectRatios
      if (supported ? !supported.includes(String(v)) : v === 'auto') {
        const allowed = (f.enum ?? []).filter((o) =>
          supported ? supported.includes(String(o)) : o !== 'auto',
        )
        const next = allowed.includes('16:9') ? '16:9' : allowed.find((o) => o !== 'auto')
        if (next !== undefined) {
          patch[k] = next
          notes.push(
            `画幅已从 ${aspectLabel(v)} 改为 ${aspectLabel(next)}（${name} 不支持 ${aspectLabel(v)}）`,
          )
        }
      }
    } else if (isRanged(k) && typeof v === 'number' && rangeOf(k, limits)) {
      const r = rangeOf(k, limits)!
      const n = clamp(v, r.min, r.max)
      if (n !== v) {
        patch[k] = n
        const unit = RANGED[k]
        const label = f.title?.replace(/（.*）/, '') ?? k
        notes.push(
          `${label}已从 ${v} ${unit}改为 ${n} ${unit}（${name} 支持 ${r.min}–${r.max} ${unit}）`,
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
  // 生成视频：连入的图片数要和所选模式对得上
  const video = node.capability === 'video.generate'
  const mode = String(params.mode ?? 'text') as VideoMode
  if (video) {
    const imageCount = ups.get('images')?.length ?? 0
    const videos = ups.get('videos')?.length ?? 0
    const audios = ups.get('audios')?.length ?? 0
    if (mode !== 'reference' && (videos || audios)) return '视频或音频参考需要选择多模态参考模式'
    if (
      model &&
      (videos > (model.limits?.referenceMedia?.video ?? 0) ||
        audios > (model.limits?.referenceMedia?.audio ?? 0))
    )
      return '当前模型不支持这些参考素材或数量超过上限'
    const problem = videoModeProblem(
      mode,
      mode === 'reference' ? imageCount + videos + audios : imageCount,
    )
    if (problem) return problem
  }
  if (!model) return null
  if (
    node.capability === 'image.process' &&
    !model.limits?.imageOperations?.includes(params.operation as 'upscale' | 'outpaint' | 'cutout')
  )
    return '当前模型不支持这项精修操作，请更换模型'
  const { patch } = adaptToModel(node, params, model)
  const limits = model.limits ?? NONE
  const name = model.title
  for (const [k, f] of fieldsOf(node)) {
    if (!(k in patch)) continue
    const v = params[k] ?? f.default
    if (f.widget === 'resolution') return `${name} 不支持分辨率 ${String(v)}`
    if (isRanged(k)) {
      const r = rangeOf(k, limits)!
      const label = f.title?.replace(/（.*）/, '') ?? k
      return `${name} 的${label}须为 ${r.min}–${r.max} ${RANGED[k]}`
    }
    if (k === 'count') return `${name} 一次最多生成 ${limits.count!.max} 张`
    return `${name} 不支持${f.title ?? k} ${String(v)}`
  }
  // 参考图：图片节点的 references；生成视频只有图片参考模式才把图当参考
  const refs = video
    ? mode === 'reference'
      ? (ups.get('images')?.length ?? 0)
      : 0
    : (ups.get('references')?.length ?? 0)
  if (limits.references && refs > limits.references.max)
    return `${name} 最多支持 ${limits.references.max} 张参考图，现在连了 ${refs} 张`
  return null
}
